// Review menu after body recording. Caller picks:
//   1 = listen back
//   2 = re-record body
//   3 = re-record handle
//   * = submit
// For anon callers, "listen back" triggers a sync ElevenLabs run with
// hold music so they can audition the scrambled version before
// submitting. For non-anon, listen back just plays their own raw
// recording. If they go straight to submit, anon processing happens
// in the background after the call ends.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbSelect } from '../../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  const digit = params.Digits;
  const sub = (await sbSelect(env, 'hir_submissions', {
    twilio_call_sid: `eq.${params.CallSid}`,
    select: 'body_audio_url,body_audio_anon_url,anon,anon_voice_id',
    limit: '1',
  }))[0];
  const isAnon = !!(sub && sub.anon);

  if (digit === '1') {
    // Listen back: anon callers run through ElevenLabs (sync, with
    // hold music). Non-anon callers just hear their original recording.
    if (isAnon) {
      return twimlResponse(`<Redirect method="POST">/api/twilio/anon-process</Redirect>`);
    }
    if (sub && sub.body_audio_url) {
      let xml = `<Play>${sub.body_audio_url}</Play>`;
      xml += `<Redirect method="POST">/api/twilio/review</Redirect>`;
      return twimlResponse(xml);
    }
  }

  if (digit === '2') {
    return twimlResponse(`<Redirect method="POST">/api/twilio/body-prompt</Redirect>`);
  }
  if (digit === '3') {
    return twimlResponse(`<Redirect method="POST">/api/twilio/handle-prompt</Redirect>`);
  }
  if (digit === '*') {
    return twimlResponse(`<Redirect method="POST">/api/twilio/submit</Redirect>`);
  }

  // First entry into menu (no digit) — read it.
  const xml = `
    <Gather numDigits="1" action="/api/twilio/review" method="POST" timeout="10">
      <Say voice="Polly.Joanna">Got it. Press 1 to listen back. Press 2 to re-record. Press 3 to re-record your handle. Press star to submit.</Say>
    </Gather>
    <Say voice="Polly.Joanna">No selection. Submitting.</Say>
    <Redirect method="POST">/api/twilio/submit</Redirect>
  `;
  return twimlResponse(xml);
}
