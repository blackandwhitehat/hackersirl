// Anon mode: let the caller audition the available scrambled voices
// before they commit. Plays a short sample of each voice via TwiML
// <Play> pointing at pre-rendered MP3 samples in Supabase Storage.
// The samples are produced once at deploy time (or by a tiny seed
// script) using ElevenLabs Speech-to-Speech on a fixed reference clip.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbUpdate } from '../../_lib/supabase.js';

// Voice catalog. The mp3 samples live at:
//   ${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/voice-samples/<id>.mp3
// And the actual ElevenLabs voice IDs are looked up from env-mapped
// secrets so we can swap voices without redeploying.
const VOICES = [
  { id: 'operator', label: 'the source',    sampleKey: 'voice-samples/operator.mp3' },
  { id: 'trucker',  label: 'the shadow',    sampleKey: 'voice-samples/trucker.mp3' },
  { id: 'anchor',   label: 'the informant', sampleKey: 'voice-samples/anchor.mp3' },
];

function sampleUrl(env, key) {
  return `${env.SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/${key}`;
}

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  const digit = params.Digits;

  // First entry — no digit yet. Play the menu intro.
  if (!digit) {
    let xml = '<Say voice="Polly.Joanna">Pick a voice. To hear a sample, press its number. Press star at any time to confirm the last voice you listened to.</Say>';
    xml += '<Gather numDigits="1" action="/api/twilio/anon-preview" method="POST" timeout="10">';
    VOICES.forEach((v, i) => {
      xml += `<Say voice="Polly.Joanna">Press ${i + 1} for ${v.label}.</Say>`;
    });
    xml += '</Gather>';
    xml += '<Say voice="Polly.Joanna">No selection. Going with the operator.</Say>';
    xml += '<Redirect method="POST">/api/twilio/anon-preview?confirmed=operator</Redirect>';
    return twimlResponse(xml);
  }

  // Confirm with star.
  if (digit === '*') {
    const url = new URL(request.url);
    const last = url.searchParams.get('last') || 'operator';
    await sbUpdate(env, 'hir_submissions', {
      twilio_call_sid: params.CallSid,
      status: 'not.in.(published,rejected,publishing,processing)',
    }, { anon_voice_id: last });
    return twimlResponse(`<Redirect method="POST">/api/twilio/handle-prompt</Redirect>`);
  }

  const idx = parseInt(digit, 10) - 1;
  if (idx >= 0 && idx < VOICES.length) {
    const v = VOICES[idx];
    let xml = `<Say voice="Polly.Joanna">${v.label}.</Say>`;
    xml += `<Play>${sampleUrl(env, v.sampleKey)}</Play>`;
    xml += `<Gather numDigits="1" action="/api/twilio/anon-preview?last=${v.id}" method="POST" timeout="6">`;
    xml += '<Say voice="Polly.Joanna">Press star to use this voice, or any other number to hear another.</Say>';
    xml += '</Gather>';
    xml += '<Say voice="Polly.Joanna">Going with this voice.</Say>';
    xml += `<Redirect method="POST">/api/twilio/anon-preview?confirmed=${v.id}</Redirect>`;
    return twimlResponse(xml);
  }

  // Confirmed via redirect (timeout fallback path).
  const url = new URL(request.url);
  const confirmed = url.searchParams.get('confirmed');
  if (confirmed) {
    await sbUpdate(env, 'hir_submissions', {
      twilio_call_sid: params.CallSid,
      status: 'not.in.(published,rejected,publishing,processing)',
    }, { anon_voice_id: confirmed });
    return twimlResponse(`<Redirect method="POST">/api/twilio/handle-prompt</Redirect>`);
  }

  // Unknown digit — replay the menu.
  return twimlResponse(`<Redirect method="POST">/api/twilio/anon-preview</Redirect>`);
}
