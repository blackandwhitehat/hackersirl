// Helpers for emitting Twilio TwiML responses. Pages Functions get the
// inbound webhook as application/x-www-form-urlencoded; we reply with
// XML that Twilio executes.

export function twimlResponse(xml) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${xml}</Response>`, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

export async function twilioForm(request) {
  const body = await request.text();
  const params = new URLSearchParams(body);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

// Verify the X-Twilio-Signature on incoming webhooks. Validates the
// request actually came from Twilio so an attacker can't fake call
// flow events. See:
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export async function verifyTwilioSignature(request, env, params, urlOverride) {
  if (env.SKIP_TWILIO_VERIFY === '1') return true; // for local testing
  const sig = request.headers.get('x-twilio-signature');
  if (!sig) return false;
  // Twilio computes HMAC-SHA1 of (full URL + sorted form fields concatenated).
  const url = urlOverride || request.url;
  const sortedKeys = Object.keys(params).sort();
  let payload = url;
  for (const k of sortedKeys) payload += k + params[k];
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.TWILIO_AUTH_TOKEN || ''),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const macB64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return macB64 === sig;
}

// Common XML escape for caller-supplied strings going into TwiML.
export function xe(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// SHA-256 the caller phone so we never store raw E.164.
export async function hashPhone(e164) {
  const data = new TextEncoder().encode(String(e164 || ''));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
