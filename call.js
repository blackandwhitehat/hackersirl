// HackersIRL browser voicemail terminal.
// Mirrors the Twilio IVR flow but runs entirely in the browser:
//   idle → connecting → menu → handle → body → review → submit
// Uses Web Audio for DTMF + ringing tones (no asset cost).
// Uses Web Speech API for IVR prompts in v0; will swap for ElevenLabs-
// rendered mp3s when the key is in place.
// Uses MediaRecorder for caller audio.
// Posts both clips + flags to /api/web/submit when the caller hits send.

(() => {
  'use strict';

  // ── DTMF table (same Hz pairs as a real phone keypad) ──────────────
  const DTMF = {
    '1':[697,1209],'2':[697,1336],'3':[697,1477],
    '4':[770,1209],'5':[770,1336],'6':[770,1477],
    '7':[852,1209],'8':[852,1336],'9':[852,1477],
    '*':[941,1209],'0':[941,1336],'#':[941,1477],
  };

  // ── Web Audio engine ───────────────────────────────────────────────
  let ctx;
  const ensureCtx = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  const tone = (freqs, ms = 140, gainTarget = 0.18) => {
    const c = ensureCtx();
    const now = c.currentTime;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gainTarget, now + 0.01);
    g.gain.setValueAtTime(gainTarget, now + ms / 1000 - 0.02);
    g.gain.linearRampToValueAtTime(0, now + ms / 1000);
    g.connect(c.destination);
    freqs.forEach(f => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g);
      o.start(now);
      o.stop(now + ms / 1000 + 0.02);
    });
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const dialTone = (ms = 1800) => tone([350, 440], ms, 0.10);
  // 440+480Hz · 2s on · 4s off — repeat 3 cycles (~14s total)
  const ringSequence = async (cycles = 3) => {
    for (let i = 0; i < cycles; i++) {
      tone([440, 480], 1900, 0.12);
      await sleep(2000);
      await sleep(4000);
    }
  };
  const pickupClick = () => tone([700], 60, 0.08);
  const hangupClick = () => tone([400, 250], 90, 0.10);
  const errorBeep = () => tone([480, 620], 250, 0.16);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Dial the HackersIRL number digit by digit, real DTMF tones, like
  // pressing the keys yourself.
  const PHONE_DIGITS = '9049154225';
  const dialNumber = async () => {
    for (const d of PHONE_DIGITS) {
      tone(DTMF[d], 110, 0.18);
      flashKey(d);
      await sleep(150);
    }
  };

  // ── Pre-rendered IVR prompts (ElevenLabs Brian, served from Storage) ──
  // Each prompt is a static MP3 in the public hackersirl-audio bucket.
  // Render script: scripts/render-ivr.sh (run once after EL key change).
  const IVR_BASE = 'https://ltaaiiqtrmlqrzhglxob.supabase.co/storage/v1/object/public/hackersirl-audio/ivr';
  const PROMPT_CACHE = {};
  let currentPromptAudio = null;

  // Preload so first DIAL → playback feels instant
  const preloadPrompts = () => {
    ['greeting','menu','anon-confirm','handle-prompt','body-prompt','review-menu','submitted'].forEach(name => {
      const a = new Audio(`${IVR_BASE}/${name}.mp3`);
      a.preload = 'auto';
      PROMPT_CACHE[name] = a;
    });
  };

  // Play a named prompt; resolves when playback ends. iOS Safari needs
  // the AudioContext unlocked first, which ensureCtx() does on every
  // tone/keypress so this is fine after the first DIAL click.
  //
  // If a previous prompt is still playing, we need to (a) pause it AND
  // (b) resolve its pending Promise — otherwise an awaiter sits forever.
  // We track each speak()'s resolver on the audio element itself so the
  // interrupting call can fire it before swapping.
  const speak = (name) => new Promise((resolve) => {
    if (currentPromptAudio) {
      try { currentPromptAudio.pause(); } catch(e) {}
      const prevResolve = currentPromptAudio._hirResolve;
      currentPromptAudio._hirResolve = null;
      if (prevResolve) prevResolve();
    }
    const cached = PROMPT_CACHE[name];
    const a = cached ? cached : new Audio(`${IVR_BASE}/${name}.mp3`);
    if (cached) a.currentTime = 0;
    a._hirResolve = resolve;
    currentPromptAudio = a;
    a.onended = () => {
      if (currentPromptAudio === a) currentPromptAudio = null;
      a._hirResolve = null;
      resolve();
    };
    a.onerror = (e) => {
      console.warn('[hir/call] prompt failed:', name, e?.message || e);
      if (currentPromptAudio === a) currentPromptAudio = null;
      a._hirResolve = null;
      resolve();
    };
    a.play().catch(err => {
      console.warn('[hir/call] play() rejected:', name, err?.message || err);
      a._hirResolve = null;
      resolve();
    });
  });

  preloadPrompts();

  // ── State machine ──────────────────────────────────────────────────
  const STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    MENU: 'menu',
    ANON_PICK_VOICE: 'anon_pick_voice',
    HANDLE_PROMPT: 'handle_prompt',
    HANDLE_RECORDING: 'handle_recording',
    BODY_PROMPT: 'body_prompt',
    BODY_RECORDING: 'body_recording',
    REVIEW: 'review',
    SUBMITTING: 'submitting',
    DONE: 'done',
    ERROR: 'error',
  };
  let state = STATE.IDLE;
  let anon = false;
  let anonVoiceId = 'operator';
  let lastPreviewedVoice = null;
  let handleBlob = null;
  let bodyBlob = null;

  const VOICE_SAMPLE_BASE = 'https://ltaaiiqtrmlqrzhglxob.supabase.co/storage/v1/object/public/hackersirl-audio/voice-samples';
  const VOICE_OPTIONS = [
    { num: '1', id: 'operator', label: 'the source' },
    { num: '2', id: 'trucker',  label: 'the shadow' },
    { num: '3', id: 'anchor',   label: 'the cipher' },
  ];

  const playVoiceSample = (id) => new Promise((resolve) => {
    if (currentPromptAudio) { try { currentPromptAudio.pause(); } catch(e){} }
    const a = new Audio(`${VOICE_SAMPLE_BASE}/${id}.mp3`);
    currentPromptAudio = a;
    a.onended = () => { currentPromptAudio = null; resolve(); };
    a.onerror = () => { currentPromptAudio = null; resolve(); };
    a.play().catch(() => resolve());
  });

  // ── DOM refs ───────────────────────────────────────────────────────
  const $status = document.getElementById('status');
  const $timer = document.getElementById('timer');
  const $wave = document.getElementById('wave');
  const $keypad = document.getElementById('keypad');
  const $dial = document.getElementById('dial');
  const $hangup = document.getElementById('hangup');

  // ── UI helpers ─────────────────────────────────────────────────────
  const setStatus = (lines) => {
    $status.innerHTML = lines.map(l => {
      if (typeof l === 'string') return `<span class="prompt">> ${l}</span>`;
      const [cls, txt] = l;
      return `<span class="${cls}">> ${txt}</span>`;
    }).join('<br>');
  };
  const flashKey = (k) => {
    const el = $keypad.querySelector(`[data-k="${k}"]`);
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 120);
  };
  const setKeypadEnabled = (enabled) => {
    $keypad.querySelectorAll('.key').forEach(k => k.disabled = !enabled);
  };
  const setDial = (label, enabled = true) => {
    $dial.textContent = label;
    $dial.disabled = !enabled;
  };
  const setHangup = (enabled) => {
    $hangup.disabled = !enabled;
  };

  // ── Timer ──────────────────────────────────────────────────────────
  let timerStart = 0;
  let timerInt = null;
  const startTimer = (recording = false) => {
    timerStart = Date.now();
    $timer.classList.toggle('recording', recording);
    timerInt = setInterval(() => {
      const s = Math.floor((Date.now() - timerStart) / 1000);
      const m = Math.floor(s / 60);
      $timer.textContent = `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
    }, 200);
  };
  const stopTimer = () => {
    if (timerInt) clearInterval(timerInt);
    timerInt = null;
  };
  const resetTimer = () => {
    stopTimer();
    $timer.textContent = '00:00';
    $timer.classList.remove('recording');
  };

  // ── Waveform (live mic visualizer) ─────────────────────────────────
  let waveAnim = null;
  let analyser = null;
  const startWave = (stream) => {
    const c = ensureCtx();
    const src = c.createMediaStreamSource(stream);
    analyser = c.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const ctx2 = $wave.getContext('2d');
    const buf = new Uint8Array(analyser.fftSize);
    const draw = () => {
      analyser.getByteTimeDomainData(buf);
      ctx2.fillStyle = '#0a0a14';
      ctx2.fillRect(0, 0, $wave.width, $wave.height);
      ctx2.lineWidth = 2;
      ctx2.strokeStyle = '#ff3355';
      ctx2.beginPath();
      const step = $wave.width / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        const y = $wave.height / 2 + v * ($wave.height / 2 - 4);
        if (i === 0) ctx2.moveTo(0, y);
        else ctx2.lineTo(i * step, y);
      }
      ctx2.stroke();
      waveAnim = requestAnimationFrame(draw);
    };
    // size canvas to its container
    $wave.width = $wave.clientWidth;
    $wave.height = $wave.clientHeight;
    draw();
  };
  const stopWave = () => {
    if (waveAnim) cancelAnimationFrame(waveAnim);
    waveAnim = null;
    if ($wave.getContext) {
      const x = $wave.getContext('2d');
      x.fillStyle = '#0a0a14';
      x.fillRect(0, 0, $wave.width, $wave.height);
    }
  };

  // ── MediaRecorder ──────────────────────────────────────────────────
  let mediaStream = null;
  let recorder = null;
  let recChunks = [];

  const ensureMic = async () => {
    if (mediaStream && mediaStream.active) return mediaStream;
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    return mediaStream;
  };
  const startRecording = async (maxMs) => {
    const stream = await ensureMic();
    startWave(stream);
    recChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
              : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
              : '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    recorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
    recorder.start();
    if (maxMs) setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop(); }, maxMs);
  };
  const stopRecording = () => new Promise((resolve) => {
    if (!recorder || recorder.state !== 'recording') return resolve(null);
    recorder.onstop = () => {
      stopWave();
      const blob = new Blob(recChunks, { type: recorder.mimeType });
      resolve(blob);
    };
    recorder.stop();
  });

  // ── Keypress + dial wiring ─────────────────────────────────────────
  const onKey = async (k) => {
    // Suppress DTMF audio while the mic is open — the speaker→mic path
    // would otherwise capture each keypress tone and bake it into the
    // recording. Visual flash still fires so the user sees the press.
    const recording = state === STATE.HANDLE_RECORDING || state === STATE.BODY_RECORDING;
    if (DTMF[k] && !recording) tone(DTMF[k]);
    flashKey(k);

    if (state === STATE.MENU) {
      if (k === '1') { anon = false; await goHandlePrompt(); }
      else if (k === '2') { anon = true; await goAnonPickVoice(); }
      else { errorBeep(); }
    } else if (state === STATE.ANON_PICK_VOICE) {
      const choice = VOICE_OPTIONS.find(v => v.num === k);
      if (choice) {
        lastPreviewedVoice = choice.id;
        anonVoiceId = choice.id;
        setStatus([
          ['meta', `auditioning: ${choice.label}`],
          ['prompt', 'press * to lock in this voice'],
          ['prompt', 'or press 1/2/3 to hear another'],
        ]);
        await playVoiceSample(choice.id);
        setStatus([
          ['ok', `last heard: ${choice.label}`],
          ['prompt', 'press * to use this voice'],
          ['prompt', 'or 1/2/3 to hear another'],
        ]);
      } else if (k === '*') {
        if (!lastPreviewedVoice) { errorBeep(); return; }
        await goHandlePrompt();
      } else {
        errorBeep();
      }
    } else if (state === STATE.REVIEW) {
      if (k === '1') { await replayBoth(); }
      else if (k === '2') { await goBodyPrompt(); }   // re-record body
      else if (k === '3') { await submit(); }
      else if (k === '*') { await hangup(); }
      else { errorBeep(); }
    }
  };

  document.addEventListener('keydown', (e) => {
    if (state === STATE.IDLE) return;
    if (DTMF[e.key]) onKey(e.key);
  });
  $keypad.addEventListener('click', (e) => {
    const btn = e.target.closest('.key');
    if (!btn) return;
    onKey(btn.dataset.k);
  });

  // ── Flow ───────────────────────────────────────────────────────────
  // Unlock HTMLAudioElement for iOS/Safari — must run inside the
  // user-gesture handler (DIAL click). Plays one cached prompt muted +
  // immediately pauses, which gives every later .play() the green light.
  const unlockAudioPlayback = async () => {
    const els = Object.values(PROMPT_CACHE);
    if (!els.length) return;
    const probe = els[0];
    try {
      probe.muted = true;
      await probe.play();
      probe.pause();
      probe.currentTime = 0;
      probe.muted = false;
    } catch (e) { /* fail open — desktop works without this */ }
  };

  const dialFlow = async () => {
    if (state !== STATE.IDLE) return;
    state = STATE.CONNECTING;
    setDial('[ DIALING... ]', false);
    setHangup(true);
    setKeypadEnabled(false);

    // Unlock audio playback FIRST while we're still in the click handler.
    await unlockAudioPlayback();

    // 1. Pickup
    setStatus([['meta', 'PICKING UP RECEIVER...']]);
    pickupClick();
    await sleep(400);

    // 2. Dial tone
    setStatus([['meta', 'DIAL TONE'], ['prompt', '...']]);
    dialTone(1500);
    await sleep(1600);

    // 3. Dial the number — DTMF 1-for-1
    setStatus([['meta', 'DIALING'], ['prompt', '1-904-915-HACK']]);
    await dialNumber();
    await sleep(400);

    // 4. Ringing
    setStatus([['meta', 'RINGING...'], ['prompt', '...']]);
    // 3 cycles is too long; do 2 (~12s). User can interrupt by hanging up.
    // Run async — pickup happens after ~6s regardless.
    const ringPromise = ringSequence(2);
    await sleep(6500);

    // 5. Pickup at other end
    pickupClick();
    setStatus([['meta', '<<< CONNECTED >>>'], ['prompt', 'hackers irl operator log']]);
    state = STATE.MENU;
    setKeypadEnabled(true);

    await speak('greeting');
    await speak('menu');
    setStatus([
      ['prompt', '1 — regular log'],
      ['prompt', '2 — anonymous (voice scrambled)'],
      ['meta', 'awaiting input...'],
    ]);
  };

  const goAnonPickVoice = async () => {
    state = STATE.ANON_PICK_VOICE;
    setKeypadEnabled(true);
    setStatus([
      ['meta', 'ANON MODE'],
      ['prompt', 'pick a voice to scramble through'],
      ['prompt', '1 — the source'],
      ['prompt', '2 — the shadow'],
      ['prompt', '3 — the cipher'],
      ['prompt', '* — use last heard'],
    ]);
    await speak('anon-confirm');
  };

  const goHandlePrompt = async () => {
    state = STATE.HANDLE_PROMPT;
    setKeypadEnabled(false);
    setStatus([['ok', anon ? `anon armed · voice: ${anonVoiceId}` : 'standard mode'], ['prompt', 'next: 5-second handle recording']]);
    await speak('handle-prompt');
    await sleep(300);
    tone([1000], 400, 0.18);
    // Wait the full beep duration + headroom for the AudioContext output
    // bus + speaker→mic crosstalk to decay before opening the recorder.
    // Anything <500ms post-beep tends to leak the tone tail into the
    // recording, which then sounds like "audio overran the prompt".
    await sleep(750);

    state = STATE.HANDLE_RECORDING;
    resetTimer();
    try {
      await startRecording(5000);
      // Visual countdown 5 → 1 so caller knows the cap.
      for (let n = 5; n >= 1; n--) {
        $timer.classList.add('recording');
        $timer.textContent = `00:0${n}`;
        setStatus([['err', '● RECORDING HANDLE'], ['meta', `${n}s left — say your handle and what you do`]]);
        await sleep(1000);
      }
      handleBlob = await stopRecording();
      stopTimer();
      tone([1000], 200, 0.18);
      await sleep(250);
      await goBodyPrompt();
    } catch (e) {
      handleError(e);
    }
  };

  const goBodyPrompt = async () => {
    state = STATE.BODY_PROMPT;
    setKeypadEnabled(false);
    setStatus([['ok', 'handle: captured'], ['prompt', 'next: up to 10 minutes of message']]);
    await speak('body-prompt');
    await sleep(300);
    tone([1000], 400, 0.18);
    await sleep(750);  // same beep-tail decay as handle (see comment above)
    state = STATE.BODY_RECORDING;
    setStatus([['err', '● RECORDING MESSAGE'], ['meta', 'press # to stop · max 10:00']]);
    resetTimer();
    startTimer(true);
    setKeypadEnabled(true);
    // Override key handler so # ends body. We intentionally DON'T play
    // the # DTMF tone here — recording is still active and the tone
    // would leak into the recording's tail. Confirmation tone fires
    // after stopRecording() returns.
    try {
      await startRecording(600 * 1000);
      await new Promise((resolve) => {
        const handler = async (k) => {
          if (k !== '#') { errorBeep(); return; }
          flashKey('#');
          $keypad.removeEventListener('click', tempClick);
          document.removeEventListener('keydown', tempKey);
          resolve();
        };
        const tempClick = (e) => { const b = e.target.closest('.key'); if (b) handler(b.dataset.k); };
        const tempKey = (e) => { if (DTMF[e.key]) handler(e.key); };
        $keypad.addEventListener('click', tempClick);
        document.addEventListener('keydown', tempKey);
        // Also auto-resolve at 10 min cap
        setTimeout(resolve, 600 * 1000);
      });
      bodyBlob = await stopRecording();
      stopTimer();
      // Now safe to play DTMF + confirmation tone — mic is closed.
      tone(DTMF['#'], 110, 0.18);
      await sleep(140);
      tone([1000], 200, 0.18);
      await goReview();
    } catch (e) {
      handleError(e);
    }
  };

  const goReview = async () => {
    state = STATE.REVIEW;
    setKeypadEnabled(true);
    setStatus([
      ['ok', 'message: captured'],
      ['prompt', '1 = play it back'],
      ['prompt', '2 = re-record message'],
      ['prompt', '3 = submit it'],
      ['prompt', '* = hang up (discard)'],
    ]);
    await speak('review-menu');
  };

  const replayBoth = async () => {
    setStatus([['meta', 'PLAYING BACK...']]);
    const playBlob = (blob) => new Promise((resolve) => {
      if (!blob) return resolve();
      const a = new Audio(URL.createObjectURL(blob));
      a.onended = resolve;
      a.onerror = resolve;
      a.play().catch(resolve);
    });
    await playBlob(handleBlob);
    await playBlob(bodyBlob);
    setStatus([
      ['ok', 'playback complete'],
      ['prompt', '1=replay  2=re-record  3=submit  *=hang up'],
    ]);
  };

  // Turnstile token holder — set by the cf-turnstile callback below.
  let turnstileToken = null;
  window.onTurnstile = (token) => { turnstileToken = token; };

  const getTurnstileToken = () => new Promise((resolve) => {
    // Already cached from auto-execute on page load (managed mode)?
    if (turnstileToken) return resolve(turnstileToken);
    // Trigger an explicit execute (invisible challenge runs invisibly).
    if (window.turnstile) {
      window.turnstile.execute('#ts-widget', { callback: (t) => { turnstileToken = t; resolve(t); } });
      // Safety timeout — if nothing arrives, resolve null and let server reject.
      setTimeout(() => resolve(turnstileToken), 8000);
    } else {
      resolve(null);
    }
  });

  const submit = async () => {
    if (!bodyBlob) return errorBeep();
    state = STATE.SUBMITTING;
    setKeypadEnabled(false);
    setHangup(false);
    setStatus([['meta', 'CHALLENGE / UPLOADING...'], ['prompt', 'do not close this window']]);
    try {
      const tsTok = await getTurnstileToken();
      const fd = new FormData();
      if (handleBlob) fd.append('handle_audio', handleBlob, 'handle.webm');
      fd.append('body_audio', bodyBlob, 'body.webm');
      fd.append('anon', anon ? '1' : '0');
      if (anon) fd.append('anon_voice_id', anonVoiceId);
      fd.append('source', 'web');
      if (tsTok) fd.append('cf_turnstile_token', tsTok);
      const r = await fetch('/api/web/submit', { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`upload failed ${r.status}`);
      const data = await r.json().catch(() => ({}));
      state = STATE.DONE;
      tone([800, 1000], 300, 0.18);
      setStatus([
        ['ok', '<<< TRANSMISSION COMPLETE >>>'],
        ['meta', `submission id: ${(data.id || '?').slice(0,8)}...`],
        ['prompt', "we'll listen, pick the ones that fit, and put them on the show"],
        ['prompt', 'thanks for picking up the phone'],
      ]);
      setDial('[ DONE ]', false);
      await speak('submitted');
    } catch (e) {
      handleError(e);
    }
  };

  // Hang-up handler. If the caller hangs up DURING body recording with
  // a usable amount of audio captured (>3s), we treat the hangup as a
  // "soft stop" — finalize the body blob, jump to review so the caller
  // can listen + submit or discard. Hangup outside recording, or with
  // <3s captured, is a true call-end (discard everything).
  const hangup = async () => {
    hangupClick();

    // Mid-recording rescue: capture what we have before tearing down.
    if (state === STATE.BODY_RECORDING && recorder && recorder.state === 'recording') {
      const elapsedSec = timerStart ? (Date.now() - timerStart) / 1000 : 0;
      bodyBlob = await stopRecording().catch(() => null);
      stopTimer();
      if (bodyBlob && bodyBlob.size > 0 && elapsedSec >= 3) {
        if (currentPromptAudio) { try { currentPromptAudio.pause(); } catch(e){} }
        setStatus([
          ['ok', 'recording captured'],
          ['prompt', `${Math.round(elapsedSec)}s recorded · jumped to review`],
        ]);
        await goReview();
        return;
      }
      // <3s — too short to be useful, fall through to discard.
    }

    if (recorder && recorder.state === 'recording') recorder.stop();
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null; recorder = null;
    handleBlob = null; bodyBlob = null;
    stopTimer(); resetTimer(); stopWave();
    state = STATE.IDLE;
    setStatus([['err', 'CALL ENDED'], ['prompt', 'press DIAL to try again']]);
    setKeypadEnabled(false);
    setHangup(false);
    setDial('[ DIAL ]', true);
    speechSynthesis.cancel();
    if (currentPromptAudio) { try { currentPromptAudio.pause(); } catch(e){} currentPromptAudio = null; }
  };

  const handleError = (e) => {
    state = STATE.ERROR;
    console.error(e);
    setStatus([['err', 'ERROR: ' + (e.message || 'something went sideways')], ['prompt', 'hang up and try again']]);
    setHangup(true);
  };

  $dial.addEventListener('click', dialFlow);
  $hangup.addEventListener('click', hangup);

  // Initial state
  setStatus([['prompt', 'terminal ready'], ['prompt', 'press DIAL to begin']]);
  setKeypadEnabled(false);
})();
