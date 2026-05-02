// Reject a submission with an optional reason.

import { sbUpdate } from '../../_lib/supabase.js';
import { isAdmin } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return new Response('forbidden', { status: 403 });
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
