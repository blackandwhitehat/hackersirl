// Streams Twilio Recording audio through our origin so the admin UI
// can play it. Twilio Recording URLs require basic auth (the account
// SID + auth token) — the browser can't send that, and the strict
// /admin/* CSP doesn't allow api.twilio.com in media-src anyway.
//
// This function takes a Recording SID (RE…), reconstructs the canonical
// Twilio URL, fetches it server-side with basic auth, and streams the
// MP3 back to the caller. Same-origin, so CSP is happy.
//
// Locked to admin (CF Access JWT) — never proxy Twilio recordings to
// anonymous callers. Whitelisted to api.twilio.com Recording paths to
// stop this from becoming an open SSRF.

import { isAdmin } from '../../_lib/auth.js';

// Twilio Recording SID format: 34 chars, starts with RE
const SID_RE = /^RE[a-f0-9]{32}$/i;

export async function onRequestGet({ request, env }) {
  if (!(await isAdmin(request, env))) return new Response('forbidden', { status: 403 });

  const url = new URL(request.url);
  const sid = url.searchParams.get('sid') || '';
  if (!SID_RE.test(sid)) return new Response('bad sid', { status: 400 });

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return new Response('twilio not configured', { status: 503 });
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`;
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);

  const upstream = await fetch(twilioUrl, {
    headers: { Authorization: `Basic ${auth}` },
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  if (!upstream.ok) {
    return new Response(`twilio ${upstream.status}`, { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'private, max-age=300',
    },
  });
}
