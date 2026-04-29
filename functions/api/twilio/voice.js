// Twilio voice webhook entry point. First thing the caller hears.
// Greets, explains the show, then drops into the open-vs-anonymous menu.

import { twimlResponse, twilioForm, verifyTwilioSignature, hashPhone } from '../../_lib/twiml.js';
import { sbInsert } from '../../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }

  // Seed a submission row keyed by Twilio CallSid so subsequent
  // callbacks can update the same record.
  const callSid = params.CallSid;
  const phoneHash = await hashPhone(params.From || '');
  await sbInsert(env, 'hir_submissions', {
    twilio_call_sid: callSid,
    caller_phone_hash: phoneHash,
    status: 'recording',
  }, { returning: false }).catch(() => { /* dup callsid is fine */ });

  // Greeting + menu, all in one TwiML so the caller hits the keypad
  // immediately without an awkward pause.
  const xml = `
    <Say voice="Polly.Joanna">Hey, you've reached the Hackers IRL operator log. This is the spot where you get to brain dump for up to ten minutes about whatever's on your mind. Cool projects, the con you just got back from, the dog that needs walking, anything. We pick the ones that feel right and put them on the show.</Say>
    <Pause length="1"/>
    <Gather numDigits="1" action="/api/twilio/menu" method="POST" timeout="8">
      <Say voice="Polly.Joanna">To leave a regular log, press 1. To stay anonymous and have your voice scrambled, press 2.</Say>
    </Gather>
    <Say voice="Polly.Joanna">No selection received. Goodbye.</Say>
    <Hangup/>
  `;
  return twimlResponse(xml);
}
