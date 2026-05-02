// Twilio posts here once the handle recording finishes. We stash the
// Twilio recording URL on the submission row (Twilio hosts the audio;
// we'll pull it down + re-upload to Supabase Storage after submit so
// nothing is left dangling on Twilio's side after the call ends).

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbUpdate } from '../../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  const recUrl = params.RecordingUrl;
  await sbUpdate(env, 'hir_submissions', {
    twilio_call_sid: params.CallSid,
    status: 'not.in.(published,rejected,publishing,processing)',
  }, {
    handle_audio_url: recUrl ? `${recUrl}.mp3` : null,
  });
  return twimlResponse(`<Redirect method="POST">/api/twilio/body-prompt</Redirect>`);
}
