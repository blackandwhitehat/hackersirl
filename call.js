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

  const dialTone = () => {
    // 350+440Hz, sustained ~1.2s
    tone([350, 440], 1200, 0.10);
  };
  const ringTone = () => {
    // 440+480Hz, 2s on / 4s off pattern. We just play a 2s pulse twice.
    tone([440, 480], 1900, 0.12);
    setTimeout(() => tone([440, 480], 1900, 0.12), 4000);
  };
  const pickupClick = () => tone([700], 60, 0.08);
  const hangupClick = () => tone([400, 250], 90, 0.10);
  const errorBeep = () => { tone([480, 620], 250, 0.16); };

  // ── Web Speech API for prompts (v0; swap to ElevenLabs MP3s later) ─
  const speak = (text) => new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { resolve(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    // Pick a US-English female voice if we can find one (closest to Twilio's Polly.Joanna)
    const voices = speechSynthesis.getVoices();
    const v = voices.find(v => /en-US/.test(v.lang) && /female|samantha|joanna|allison|kate/i.test(v.name))
           || voices.find(v => /en-US/.test(v.lang))
           || voices[0];
    if (v) u.voice = v;
    u.rate = 1.0;
    u.pitch = 1.0;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });

  // Some browsers populate voices async — warm them.
  if ('speechSynthesis' in window) speechSynthesis.getVoices();

  // ── State machine ──────────────────────────────────────────────────
  const STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    MENU: 'menu',
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
  let handleBlob = null;
  let bodyBlob = null;

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
    if (DTMF[k]) tone(DTMF[k]);
    flashKey(k);

    if (state === STATE.MENU) {
      if (k === '1') { anon = false; await goHandlePrompt(); }
      else if (k === '2') { anon = true; await speak("Anonymous mode. Your voice will be scrambled before anyone hears it. For now I'll just record you straight; the swap happens server-side."); await goHandlePrompt(); }
      else { errorBeep(); }
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
  const dialFlow = async () => {
    if (state !== STATE.IDLE) return;
    state = STATE.CONNECTING;
    setDial('[ DIALING... ]', false);
    setHangup(true);
    setKeypadEnabled(false);
    setStatus([['meta', 'CONNECTION ESTABLISHED'], ['prompt', 'dialing 1-904-915-HACK ...']]);
    dialTone();
    await new Promise(r => setTimeout(r, 1200));
    setStatus([['meta', 'ringing...']]);
    ringTone();
    await new Promise(r => setTimeout(r, 1800));
    pickupClick();
    setStatus([['meta', '<<< PICKED UP >>>'], ['prompt', 'hackers irl operator log']]);
    state = STATE.MENU;
    setKeypadEnabled(true);
    await speak("Hey, you've reached the Hackers IRL operator log. Brain dump for up to ten minutes about whatever's on your mind.");
    await speak("To leave a regular log, press 1. To stay anonymous, press 2.");
    setStatus([
      ['prompt', 'press 1: regular log'],
      ['prompt', 'press 2: anonymous (voice scrambled)'],
      ['meta', 'awaiting input...'],
    ]);
  };

  const goHandlePrompt = async () => {
    state = STATE.HANDLE_PROMPT;
    setKeypadEnabled(false);
    setStatus([['ok', anon ? 'anonymous mode armed' : 'standard mode'], ['prompt', 'next: 5-second handle recording']]);
    await speak("Record your handle and what you do, in five seconds, after the tone.");
    tone([1000], 350, 0.18);
    state = STATE.HANDLE_RECORDING;
    setStatus([['err', '● RECORDING HANDLE'], ['meta', '5 seconds...']]);
    resetTimer();
    startTimer(true);
    try {
      await startRecording(5000);
      // Wait for the auto-stop
      await new Promise(r => setTimeout(r, 5050));
      handleBlob = await stopRecording();
      stopTimer();
      tone([1000], 200, 0.18);
      await goBodyPrompt();
    } catch (e) {
      handleError(e);
    }
  };

  const goBodyPrompt = async () => {
    state = STATE.BODY_PROMPT;
    setKeypadEnabled(false);
    setStatus([['ok', 'handle: captured'], ['prompt', 'next: up to 10 minutes of message']]);
    await speak("Now give us your message. Up to ten minutes. Press the pound key when you're done.");
    tone([1000], 350, 0.18);
    state = STATE.BODY_RECORDING;
    setStatus([['err', '● RECORDING MESSAGE'], ['meta', 'press # to stop · max 10:00']]);
    resetTimer();
    startTimer(true);
    setKeypadEnabled(true);
    // Override key handler so # ends body
    try {
      await startRecording(600 * 1000);
      await new Promise((resolve) => {
        const handler = async (k) => {
          if (k !== '#') { errorBeep(); return; }
          flashKey('#'); tone(DTMF['#']);
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
    await speak("Press one to hear it back. Two to re-record. Three to send it. Star to hang up.");
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

  const submit = async () => {
    if (!bodyBlob) return errorBeep();
    state = STATE.SUBMITTING;
    setKeypadEnabled(false);
    setHangup(false);
    setStatus([['meta', 'UPLOADING TO TOWER...'], ['prompt', 'do not close this window']]);
    try {
      const fd = new FormData();
      if (handleBlob) fd.append('handle_audio', handleBlob, 'handle.webm');
      fd.append('body_audio', bodyBlob, 'body.webm');
      fd.append('anon', anon ? '1' : '0');
      fd.append('source', 'web');
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
    } catch (e) {
      handleError(e);
    }
  };

  const hangup = async () => {
    hangupClick();
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
