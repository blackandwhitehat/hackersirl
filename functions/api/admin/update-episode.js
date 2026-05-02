// Edit a published (or pending) episode's metadata. Title, description,
// episode_number, season — anything except the audio. RSS feed picks
// up the change on next pull (≤5min CDN cache). The MP3's embedded
// ID3 tags are not retagged; podcast players re-read the RSS for
// title/desc, so this is the right tier to update.
//
// Body: { episode_id, title?, description?, episode_number?, season?,
//         is_explicit? }

import { sbUpdate } from '../../_lib/supabase.js';
import { isAdmin } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return new Response('forbidden', { status: 403 });
  const body = await request.json().catch(() => ({}));
  const { episode_id, title, description, episode_number, season, is_explicit } = body;
  if (!episode_id) return new Response('episode_id required', { status: 400 });

  const patch = {};
  if (typeof title === 'string')           patch.title = title;
  if (typeof description === 'string')     patch.description = description;
  if (episode_number === null || typeof episode_number === 'number') patch.episode_number = episode_number;
  if (season === null || typeof season === 'number') patch.season = season;
  if (typeof is_explicit === 'boolean')    patch.is_explicit = is_explicit;

  if (Object.keys(patch).length === 0) {
    return new Response('no fields to update', { status: 400 });
  }

  const updated = await sbUpdate(env, 'hir_episodes', { id: episode_id }, patch);
  return new Response(JSON.stringify(updated), {
    headers: { 'content-type': 'application/json' },
  });
}
