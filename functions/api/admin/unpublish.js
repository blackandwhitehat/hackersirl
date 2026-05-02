// Unpublish an episode: flip it off the live RSS feed and bring the
// submission back to 'ready' so it can be edited + re-published.
//
// Symmetric to publish.js. Doesn't delete the rendered MP3 — admins
// can flip back to live without re-running the ffmpeg mix. For
// permanent removal, follow up with a reject (handled by reject.js).

import { sbSelect, sbUpdate } from '../../_lib/supabase.js';
import { isAdmin } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!(await isAdmin(request, env))) return new Response('forbidden', { status: 403 });
  const { episode_id } = await request.json();
  if (!episode_id) return new Response('episode_id required', { status: 400 });

  const ep = (await sbSelect(env, 'hir_episodes', {
    id: `eq.${episode_id}`,
    select: 'id,submission_id',
    limit: '1',
  }))[0];
  if (!ep) return new Response('not found', { status: 404 });

  await sbUpdate(env, 'hir_episodes', { id: episode_id }, {
    processing_state: 'unpublished',
    published_at: null,
  });
  if (ep.submission_id) {
    await sbUpdate(env, 'hir_submissions', { id: ep.submission_id }, { status: 'ready' });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
}
