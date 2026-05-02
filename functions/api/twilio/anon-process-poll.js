// Polled by Twilio's redirect loop while we wait for the ElevenLabs
// swap to land. If the anon mp3 URL is set on the row, play it back;
// otherwise keep playing hold music. Bounded retry so a permanent
// failure doesn't trap the caller in a loop.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbSelect } from '../../_lib/supabase.js';
import { holdMusicUrl } from '../../_lib/hold-music.js';

const MAX_WAIT_LOOPS = 15;     // each loop is ~6s of hold music
const HOLD_MUSIC_LOOP_SEC = 6;

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  const url = new URL(request.url);
  const tries = parseInt(url.searchParams.get('tries') || '0', 10);

  const sub = (await sbSelect(env, 'hir_submissions', {
    twilio_call_sid: `eq.${params.CallSid}`,
    select: 'body_audio_anon_url',
    limit: '1',
  }))[0];

  if (sub && sub.body_audio_anon_url) {
    let xml = '<Say voice="Polly.Joanna">Here is the scrambled version.</Say>';
    xml += `<Play>${sub.body_audio_anon_url}</Play>`;
    xml += `<Redirect method="POST">/api/twilio/review</Redirect>`;
    return twimlResponse(xml);
  }

  if (tries >= MAX_WAIT_LOOPS) {
    let xml = '<Say voice="Polly.Joanna">Still working on the scrambled version. We will process it in the background and you can listen back when it is ready.</Say>';
    xml += '<Redirect method="POST">/api/twilio/review</Redirect>';
    return twimlResponse(xml);
  }

  // Keep waiting — pick a fresh random track each loop.
  let xml = `<Play>${holdMusicUrl(env)}</Play>`;
  xml += `<Redirect method="POST">/api/twilio/anon-process-poll?tries=${tries + 1}</Redirect>`;
  return twimlResponse(xml);
}
