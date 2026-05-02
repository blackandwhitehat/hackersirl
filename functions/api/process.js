// Background processor — pull a submission's recordings off Twilio,
// re-host in Supabase Storage, run anon swap if needed. All
// non-blocking on the caller's side (called via waitUntil from
// /api/twilio/submit).
//
// Transcript + title/description draft happen out-of-band on the
// quantos-bot host via the hackersirl-process cron (mlx_whisper +
// claude -p). When that lands, the row gains transcript +
// suggested_title + suggested_description; the admin queue picks
// them up automatically on next refresh.
//
// Protected by INTERNAL_SECRET so external callers can't trigger it.

import { sbSelect, sbUpdate, sbStorageUpload, sbStorageDelete } from '../_lib/supabase.js';
import { resolveVoice, swapVoice, transcribe, ttsText, isolateVoice } from '../_lib/elevenlabs.js';
import { timingSafeEqual } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  // Fail closed: if the secret env is unset, reject everything.
  // Old behavior fell back to the literal '__missing__' which made
  // the bypass discoverable just by reading source.
  if (!env.INTERNAL_SECRET) {
    console.error('process.js: INTERNAL_SECRET unset — rejecting');
    return new Response('service unavailable', { status: 503 });
  }
  const presented = request.headers.get('x-internal-secret') || '';
  if (!timingSafeEqual(presented, env.INTERNAL_SECRET)) {
    return new Response('forbidden', { status: 403 });
  }
  const { call_sid } = await request.json();
  if (!call_sid) return new Response('call_sid required', { status: 400 });

  const sub = (await sbSelect(env, 'hir_submissions', {
    twilio_call_sid: `eq.${call_sid}`,
    select: 'id,handle_audio_url,body_audio_url,body_audio_anon_url,anon,anon_voice_id',
    limit: '1',
  }))[0];
  if (!sub) return new Response('not found', { status: 404 });

  const twilioAuth = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const fetchTwilio = async (url) => {
    const r = await fetch(url, { headers: { authorization: twilioAuth } });
    if (!r.ok) throw new Error(`twilio fetch ${r.status} for ${url}`);
    return new Uint8Array(await r.arrayBuffer());
  };

  // Pull and re-host both legs.
  const updates = {};
  if (sub.handle_audio_url && sub.handle_audio_url.includes('twilio.com')) {
    const buf = await fetchTwilio(sub.handle_audio_url);
    updates.handle_audio_url = await sbStorageUpload(env, 'hackersirl-audio', `handle/${sub.id}.mp3`, buf, 'audio/mpeg');
  }
  let bodyBuf = null;
  if (sub.body_audio_url && sub.body_audio_url.includes('twilio.com')) {
    bodyBuf = await fetchTwilio(sub.body_audio_url);
    // Voice Isolator pass — strip background noise (line hum, room
    // tone, traffic, etc) before storing. EL minimum is ~4.6s; if
    // body is too short or isolator fails, fall back to original.
    let cleanedBody = bodyBuf;
    if (env.ELEVENLABS_API_KEY && bodyBuf.byteLength > 50_000) {
      try {
        cleanedBody = await isolateVoice(env, bodyBuf);
      } catch (e) {
        console.error('voice isolator failed (using raw):', e?.message || e);
      }
    }
    updates.body_audio_url = await sbStorageUpload(env, 'hackersirl-audio', `body/${sub.id}.mp3`, cleanedBody, 'audio/mpeg');
    bodyBuf = cleanedBody;
  }

  // Anon path: speech-to-speech voice swap. Keeps the caller's exact
  // words and timing — only the timbre is replaced. Settings are
  // cranked to maximum suppression in _lib/elevenlabs.js swapVoice.
  // S2S is preferred over TTS-of-transcript: a Scribe mistranscription
  // would silently corrupt content, which is worse than imperfect
  // voice anonymization. Skip if already done in-call by anon-process.
  if (sub.anon && !sub.body_audio_anon_url && bodyBuf && env.ELEVENLABS_API_KEY) {
    try {
      const voiceId = resolveVoice(env, sub.anon_voice_id || 'operator');
      const swapped = await swapVoice(env, bodyBuf, voiceId);
      updates.body_audio_anon_url = await sbStorageUpload(env, 'hackersirl-audio', `anon/${sub.id}.mp3`, swapped, 'audio/mpeg');
    } catch (e) {
      console.error('anon swap failed:', e);
    }
  }

  // Handle "presenter" pass: transcribe the caller's recorded handle
  // and have the AI presenter (env.ELEVENLABS_VOICE_PRESENTER, fallback
  // to the anchor voice) re-speak it. The final mix uses this in place
  // of the raw handle audio so the show feels produced and the caller's
  // voice doesn't appear before the (already anonymized) body.
  if (sub.handle_audio_url && !sub.handle_presented_url && env.ELEVENLABS_API_KEY) {
    try {
      const handleBuf = await fetchTwilio(updates.handle_audio_url || sub.handle_audio_url).catch(() =>
        // If the URL is already Supabase (re-hosted earlier), fetch without auth.
        fetch(updates.handle_audio_url || sub.handle_audio_url).then(r => r.ok ? r.arrayBuffer().then(b => new Uint8Array(b)) : null)
      );
      if (handleBuf) {
        const handleText = (await transcribe(env, handleBuf) || '').trim();
        if (handleText && handleText.length >= 2 && handleText.length <= 80) {
          const presenterVoice = env.ELEVENLABS_VOICE_PRESENTER || env.ELEVENLABS_VOICE_ANCHOR;
          if (presenterVoice) {
            const ttsAudio = await ttsText(env, presenterVoice, handleText);
            updates.handle_presented_url = await sbStorageUpload(env, 'hackersirl-audio', `handle-presented/${sub.id}.mp3`, ttsAudio, 'audio/mpeg');
            updates.handle_text = handleText;
          }
        }
      }
    } catch (e) {
      console.error('handle presenter pass failed:', e);
    }
  }

  // Anonymity guard: once the anon TTS exists, scrub the raw
  // caller voice from the public bucket and null the URL on the
  // row so the admin queue doesn't link to it. The published
  // episode uses the anon URL; we never need the raw again.
  // Only deletes when:
  //   - submission is anon, AND
  //   - the anon URL exists (just rendered or was rendered earlier
  //     by /api/twilio/anon-process), AND
  //   - we know the body Storage path (sub.id-based).
  const anonUrlNow = updates.body_audio_anon_url || sub.body_audio_anon_url;
  if (sub.anon && anonUrlNow) {
    try {
      await sbStorageDelete(env, 'hackersirl-audio', `body/${sub.id}.mp3`);
      updates.body_audio_url = null;
    } catch (e) {
      console.error('raw body delete failed (anonymity gap):', e?.message || e);
    }
  }

  updates.status = 'ready';
  await sbUpdate(env, 'hir_submissions', { id: sub.id }, updates);
  return new Response('ok', { status: 200 });
}
