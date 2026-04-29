// Prompt the caller to record their handle (60s cap). Twilio's
// <Record> block automatically posts the recording URL back to the
// `action` URL when the caller stops speaking or presses #.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  const xml = `
    <Say voice="Polly.Joanna">First, your handle. Say what you'd like us to call you on the show. Talk after the beep, then press pound when you're done. Up to one minute.</Say>
    <Record
      action="/api/twilio/handle-recorded"
      method="POST"
      timeout="3"
      maxLength="60"
      finishOnKey="#"
      playBeep="true"
      trim="trim-silence"/>
    <Say voice="Polly.Joanna">No recording received. Goodbye.</Say>
    <Hangup/>
  `;
  return twimlResponse(xml);
}
