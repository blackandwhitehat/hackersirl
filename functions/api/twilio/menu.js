// Caller picked open (1) or anonymous (2). Open path goes straight to
// handle recording. Anon path goes through a voice-preview submenu so
// the caller can audition the available scrambled voices first.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbUpdate } from '../../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  const choice = params.Digits;

  if (choice === '2') {
    await sbUpdate(env, 'hir_submissions', {
      twilio_call_sid: params.CallSid,
      status: 'not.in.(published,rejected,publishing,processing)',
    }, { anon: true });
    return twimlResponse(`<Redirect method="POST">/api/twilio/anon-preview</Redirect>`);
  }

  // Default = open. Move on to handle recording.
  return twimlResponse(`<Redirect method="POST">/api/twilio/handle-prompt</Redirect>`);
}
