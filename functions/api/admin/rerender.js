// Manually trigger a re-render of one or all live episodes. Sets the
// target row(s) processing_state='pending' so the next cron tick
// picks them up. Doesn't touch the live audio_url — it stays served
// until the new render lands.
//
// POST {} → re-render every live episode in the catalog
// POST { episode_id } → re-render just that one
//
// The cron's stale-check pass already auto-detects hash mismatches
// every 2 min; this endpoint is for the manual case (e.g. you want
// to force a re-render even when no asset changed, or you want to
// bypass the wait for the next stale scan).

import { sbSelect, sbUpdate } from '../../_lib/supabase.js';
import { isAdmin } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!(await isAdmin(request, env))) return new Response('forbidden', { status: 403 });
  const body = await request.json().catch(() => ({}));
  const episodeId = body.episode_id;

  if (episodeId) {
    await sbUpdate(env, 'hir_episodes', { id: episodeId }, { processing_state: 'pending' });
    return new Response(JSON.stringify({ ok: true, episodes_marked: 1 }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Catalog-wide re-render: pull all live episodes, flip each.
  const rows = await sbSelect(env, 'hir_episodes', {
    processing_state: 'eq.live',
    select: 'id',
    limit: '1000',
  });
  for (const row of rows) {
    await sbUpdate(env, 'hir_episodes', { id: row.id }, { processing_state: 'pending' });
  }
  return new Response(JSON.stringify({ ok: true, episodes_marked: rows.length }), {
    headers: { 'content-type': 'application/json' },
  });
}
