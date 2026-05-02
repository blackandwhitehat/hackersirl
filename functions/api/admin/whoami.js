// Cheap probe the admin UI hits before rendering anything. Returns
// 200 + the admin email only if isAdmin() passes; 401 otherwise.
// The UI uses this as a binary "should I show the queue or the
// sign-in card" signal — not for displaying identity (CF Access
// already exposes that via /cdn-cgi/access/get-identity).

import { isAdmin } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const accessEmail = request.headers.get('cf-access-authenticated-user-email') || '';
  const adminEmail = env.ADMIN_EMAIL || '';
  if (!isAdmin(request, env)) {
    // Debug: include every cf-* header so we can see exactly what
    // CF Access is (or isn't) forwarding. Stripped once auth chain
    // is verified end-to-end.
    const cfHeaders = {};
    for (const [k, v] of request.headers.entries()) {
      if (k.startsWith('cf-')) cfHeaders[k] = v.length > 80 ? v.slice(0, 80) + '...' : v;
    }
    return new Response(JSON.stringify({
      admin: false,
      saw_email: accessEmail || null,
      env_email_set: !!adminEmail,
      match: accessEmail.toLowerCase() === adminEmail.toLowerCase(),
      cf_headers: cfHeaders,
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ admin: true, email: accessEmail.toLowerCase() }), {
    headers: { 'content-type': 'application/json' },
  });
}
