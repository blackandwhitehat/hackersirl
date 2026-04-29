// Reject a submission with an optional reason.

import { sbUpdate } from '../../_lib/supabase.js';

function authorized(request, env) {
  const accessEmail = request.headers.get('cf-access-authenticated-user-email');
  if (accessEmail && env.ADMIN_EMAIL && accessEmail.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()) {
    return true;
  }
  const auth = request.headers.get('authorization') || '';
  if (env.ADMIN_BEARER && auth === `Bearer ${env.ADMIN_BEARER}`) return true;
  return false;
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return new Response('forbidden', { status: 403 });
  const { submission_id, reason } = await request.json();
  if (!submission_id) return new Response('submission_id required', { status: 400 });
  await sbUpdate(env, 'hir_submissions', { id: submission_id }, {
    status: 'rejected',
    reject_reason: reason || null,
  });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
}
