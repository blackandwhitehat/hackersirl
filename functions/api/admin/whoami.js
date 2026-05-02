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
    // Debug: include what the function actually saw so we can tell
    // whether CF Access is forwarding identity. The values are not
    // secret (the user already knows their own email), and we strip
    // this once the auth chain is verified end-to-end.
    return new Response(JSON.stringify({
      admin: false,
      saw_email: accessEmail || null,
      env_email_set: !!adminEmail,
      match: accessEmail.toLowerCase() === adminEmail.toLowerCase(),
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ admin: true, email: accessEmail.toLowerCase() }), {
    headers: { 'content-type': 'application/json' },
  });
}
