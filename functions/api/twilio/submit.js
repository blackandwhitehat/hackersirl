// Caller hit submit. Acknowledge, hang up, then kick off background
// processing: pull the Twilio recordings, store in Supabase Storage,
// run anon swap (if anon and not already done), transcribe, draft
// title + description.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbUpdate } from '../../_lib/supabase.js';

export async function onRequestPost({ request, env, waitUntil }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  await sbUpdate(env, 'hir_submissions', { twilio_call_sid: params.CallSid }, { status: 'processing' });

  // Fire-and-forget the post-processing pipeline. We hit our own
  // /api/process endpoint with the call sid; that handler runs the
  // full chain (download from Twilio, upload to Storage, swap voice
  // if anon, transcribe, draft title/desc).
  const baseUrl = new URL(request.url).origin;
  waitUntil(fetch(`${baseUrl}/api/process`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': env.INTERNAL_SECRET || '',
    },
    body: JSON.stringify({ call_sid: params.CallSid }),
  }).catch(() => {}));

  const xml = `
    <Say voice="Polly.Joanna">Got it. Thanks for calling. We'll review and you might hear yourself on an episode soon. Talk to you later.</Say>
    <Hangup/>
  `;
  return twimlResponse(xml);
}
