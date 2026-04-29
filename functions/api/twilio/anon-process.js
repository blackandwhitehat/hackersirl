// Sync anon path: caller wants to hear the scrambled version before
// submitting. We download the body recording from Twilio, send to
// ElevenLabs Speech-to-Speech with the chosen voice, store the result
// in Supabase Storage, then play it back. While processing, the
// caller hears hold music. Typical latency for a 10-min clip is
// 30-60s; ElevenLabs can stream output but we accumulate so we can
// store it for the admin queue too.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbSelect, sbUpdate, sbStorageUpload } from '../../_lib/supabase.js';
import { ELEVENLABS_VOICES, swapVoice } from '../../_lib/elevenlabs.js';

export async function onRequestPost({ request, env, waitUntil }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  // If the anon mp3 is already on file (caller hit "listen back"
  // twice), just play it immediately.
  const sub = (await sbSelect(env, 'hir_submissions', {
    twilio_call_sid: `eq.${params.CallSid}`,
    select: 'id,body_audio_url,body_audio_anon_url,anon_voice_id',
    limit: '1',
  }))[0];

  if (sub && sub.body_audio_anon_url) {
    let xml = `<Play>${sub.body_audio_anon_url}</Play>`;
    xml += `<Redirect method="POST">/api/twilio/review</Redirect>`;
    return twimlResponse(xml);
  }

  // Kick off the swap async via a self-call so the caller hears hold
  // music immediately. anon-process-poll keeps polling Supabase for
  // the swap to land before redirecting back to playback.
  if (sub && sub.body_audio_url && env.ELEVENLABS_API_KEY) {
    waitUntil(processAnon(env, sub.id, sub.body_audio_url, sub.anon_voice_id || 'operator'));
  }
  // Hold music + recheck loop. Twilio's <Play loop> repeats the file
  // and the Redirect kicks back to anon-process-poll which decides
  // whether to keep waiting or play the result.
  let xml = '<Say voice="Polly.Joanna">Working on the scrambled version. Please hold.</Say>';
  xml += `<Play loop="0">${env.HOLD_MUSIC_URL || `${env.SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/hold-music.mp3`}</Play>`;
  xml += `<Redirect method="POST">/api/twilio/anon-process-poll</Redirect>`;
  return twimlResponse(xml);
}

async function processAnon(env, submissionId, twilioMp3Url, voiceId) {
  try {
    const cfg = ELEVENLABS_VOICES[voiceId] || ELEVENLABS_VOICES.operator;
    const elVoiceId = cfg.elevenlabsVoiceId;
    if (!elVoiceId) return;

    // Pull the Twilio recording (basic auth required; Twilio's
    // recording endpoints are protected).
    const twilioAuth = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const audio = await fetch(twilioMp3Url, { headers: { authorization: twilioAuth } });
    if (!audio.ok) return;
    const audioBuf = await audio.arrayBuffer();

    const swapped = await swapVoice(env, audioBuf, elVoiceId);
    const url = await sbStorageUpload(
      env,
      'hackersirl-audio',
      `anon/${submissionId}.mp3`,
      swapped,
      'audio/mpeg'
    );
    await sbUpdate(env, 'hir_submissions', { id: submissionId }, { body_audio_anon_url: url });
  } catch (e) {
    // Swallow — caller will get a graceful "still processing" path.
    console.error('anon process failed:', e);
  }
}
