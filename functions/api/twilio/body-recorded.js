// Body recording finished. Save the URL, drop into the review menu.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbUpdate } from '../../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  await sbUpdate(env, 'hir_submissions', {
    twilio_call_sid: params.CallSid,
    status: 'not.in.(published,rejected,publishing,processing)',
  }, {
    body_audio_url: params.RecordingUrl ? `${params.RecordingUrl}.mp3` : null,
    duration_seconds: parseInt(params.RecordingDuration, 10) || null,
  });
  return twimlResponse(`<Redirect method="POST">/api/twilio/review</Redirect>`);
}
