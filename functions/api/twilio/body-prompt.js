// Body recording: up to 10 minutes. Pressing pound or going silent
// for 3s ends the recording; Twilio then posts to body-recorded.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  const xml = `
    <Say voice="Polly.Joanna">Now your operator log. Up to ten minutes about whatever you want. After the beep, talk away. Press pound or stop talking when you're done.</Say>
    <Record
      action="/api/twilio/body-recorded"
      method="POST"
      timeout="10"
      maxLength="600"
      finishOnKey="#"
      playBeep="true"/>
    <Say voice="Polly.Joanna">No recording received. Goodbye.</Say>
    <Hangup/>
  `;
  return twimlResponse(xml);
}
