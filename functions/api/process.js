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

import { sbSelect, sbUpdate, sbStorageUpload } from '../_lib/supabase.js';
import { resolveVoice, transcribe, ttsText, isolateVoice } from '../_lib/elevenlabs.js';

export async function onRequestPost({ request, env }) {
  if ((request.headers.get('x-internal-secret') || '') !== (env.INTERNAL_SECRET || '__missing__')) {
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

  // Anon path: TTS-of-transcript via Scribe + EL TTS. True voice
  // replacement, no source-caller traces. Skip if already done
  // in-call by /api/twilio/anon-process.
  if (sub.anon && !sub.body_audio_anon_url && bodyBuf && env.ELEVENLABS_API_KEY) {
    try {
      const voiceId = resolveVoice(env, sub.anon_voice_id || 'operator');
      const transcript = await transcribe(env, bodyBuf);
      if (transcript && transcript.length >= 3) {
        const ttsAudio = await ttsText(env, voiceId, transcript);
        updates.body_audio_anon_url = await sbStorageUpload(env, 'hackersirl-audio', `anon/${sub.id}.mp3`, ttsAudio, 'audio/mpeg');
        if (!sub.transcript) updates.transcript = transcript;
      }
    } catch (e) {
      console.error('anon TTS failed:', e);
    }
  }

  updates.status = 'ready';
  await sbUpdate(env, 'hir_submissions', { id: sub.id }, updates);
  return new Response('ok', { status: 200 });
}
