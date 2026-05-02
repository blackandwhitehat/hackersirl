// Manually trigger a re-render of episodes and/or previews. The cron's
// stale-check pass auto-detects hash mismatches every 2 min; this
// endpoint is for the manual case (force re-render even when no asset
// changed, or skip the wait for the next stale scan).
//
// POST {}                       → re-render every live episode + clear
//                                 every preview, catalog-wide
// POST { episode_id }           → just that episode
// POST { submission_id }        → just that submission's preview
// POST { episode_id, submission_id } → both (for the per-row UI button)

import { sbSelect, sbUpdate } from '../../_lib/supabase.js';
import { isAdmin } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!(await isAdmin(request, env))) return new Response('forbidden', { status: 403 });
  const body = await request.json().catch(() => ({}));
  const episodeId = body.episode_id;
  const submissionId = body.submission_id;

  let episodesMarked = 0;
  let previewsCleared = 0;

  if (episodeId) {
    await sbUpdate(env, 'hir_episodes', { id: episodeId }, { processing_state: 'pending' });
    episodesMarked = 1;
  }
  if (submissionId) {
    await sbUpdate(env, 'hir_submissions', { id: submissionId },
      { preview_audio_url: null, preview_input_hash: null });
    previewsCleared = 1;
  }
  if (episodeId || submissionId) {
    return new Response(JSON.stringify({ ok: true, episodes_marked: episodesMarked, previews_cleared: previewsCleared }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // No specific id → catalog-wide. Flip every live episode + clear
  // every preview so the cron picks them all up next tick.
  const eps = await sbSelect(env, 'hir_episodes', {
    processing_state: 'eq.live', select: 'id', limit: '1000',
  });
  for (const r of eps) {
    await sbUpdate(env, 'hir_episodes', { id: r.id }, { processing_state: 'pending' });
  }
  episodesMarked = eps.length;

  const subs = await sbSelect(env, 'hir_submissions', {
    status: 'eq.ready', preview_audio_url: 'not.is.null', select: 'id', limit: '1000',
  });
  for (const r of subs) {
    await sbUpdate(env, 'hir_submissions', { id: r.id },
      { preview_audio_url: null, preview_input_hash: null });
  }
  previewsCleared = subs.length;

  return new Response(JSON.stringify({ ok: true, episodes_marked: episodesMarked, previews_cleared: previewsCleared }), {
    headers: { 'content-type': 'application/json' },
  });
}
