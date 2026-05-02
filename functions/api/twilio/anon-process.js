// Sync anon path: caller wants to hear the scrambled version before
// submitting. We download the body recording from Twilio, send to
// ElevenLabs Speech-to-Speech with the chosen voice, store the result
// in Supabase Storage, then play it back. While processing, the
// caller hears hold music. Typical latency for a 10-min clip is
// 30-60s; ElevenLabs can stream output but we accumulate so we can
// store it for the admin queue too.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbSelect, sbUpdate, sbStorageUpload } from '../../_lib/supabase.js';
import { resolveVoice, transcribe, ttsText } from '../../_lib/elevenlabs.js';
import { holdMusicUrl } from '../../_lib/hold-music.js';

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
  // Play hold music ONCE then bounce to anon-process-poll. The poll
  // either plays the swapped audio (if ready) or restarts this loop.
  // ❌ Don't use loop="0" — that's INFINITE in TwiML and Redirect
  // becomes unreachable. Bug repro: caller stuck on hold music forever
  // even though the swap completed in the background.
  let xml = '<Say voice="Polly.Joanna">Working on the scrambled version. Please hold.</Say>';
  xml += `<Play>${holdMusicUrl(env)}</Play>`;
  xml += `<Redirect method="POST">/api/twilio/anon-process-poll</Redirect>`;
  return twimlResponse(xml);
}

// Live TTS-of-transcript path — true voice replacement, zero source
// caller traces. Pipeline:
//   Twilio recording → ElevenLabs Scribe → ElevenLabs TTS in target
//   voice → upload as body_audio_anon_url → poll loop plays it
async function processAnon(env, submissionId, twilioMp3Url, voiceId) {
  try {
    const elVoiceId = resolveVoice(env, voiceId || 'operator');
    if (!elVoiceId) return;

    const twilioAuth = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const audio = await fetch(twilioMp3Url, { headers: { authorization: twilioAuth } });
    if (!audio.ok) return;
    const audioBuf = new Uint8Array(await audio.arrayBuffer());

    // 1. Transcribe via Scribe.
    const transcript = await transcribe(env, audioBuf);
    if (!transcript || transcript.length < 3) {
      console.error('anon transcribe returned empty for', submissionId);
      return;
    }

    // 2. TTS the transcript in the chosen target voice.
    const ttsAudio = await ttsText(env, elVoiceId, transcript);

    // 3. Upload as the canonical anon audio + persist transcript so
    //    the show-notes pipeline doesn't have to re-transcribe.
    const url = await sbStorageUpload(
      env,
      'hackersirl-audio',
      `anon/${submissionId}.mp3`,
      ttsAudio,
      'audio/mpeg'
    );
    await sbUpdate(env, 'hir_submissions', { id: submissionId }, {
      body_audio_anon_url: url,
      transcript,
    });
  } catch (e) {
    console.error('anon process failed:', e);
  }
}
