// Cheap probe the admin UI hits before rendering anything. Returns
// 200 + the admin email only if isAdmin() passes; 401 otherwise.
// The UI uses this as a binary "should I show the queue or the
// sign-in card" signal — not for displaying identity (CF Access
// already exposes that via /cdn-cgi/access/get-identity).

import { isAdmin } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) {
    return new Response(JSON.stringify({ admin: false }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const email = (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase();
  return new Response(JSON.stringify({ admin: true, email }), {
    headers: { 'content-type': 'application/json' },
  });
}
