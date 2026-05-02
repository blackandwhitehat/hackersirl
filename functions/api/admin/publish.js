// Publish a submission as an episode. Synchronous client work is
// minimal: insert an hir_episodes row in 'pending' state with the
// source audio URL captured. The quantos-bot publish cron picks it
// up, runs ffmpeg (concat intro+body+outro, loudnorm, encode to MP3,
// ID3 tag), uploads the final MP3 to hackersirl-audio/episodes/, and
// flips processing_state='live' which is what feed.xml emits.
//
// Body: { submission_id, title, description, episode_number?, season?,
//         is_explicit? }

import { sbSelect, sbInsert, sbUpdate } from '../../_lib/supabase.js';
import { isAdmin } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return new Response('forbidden', { status: 403 });
  const body = await request.json();
  const { submission_id, title, description, episode_number, season, is_explicit } = body || {};
  if (!submission_id || !title || !description) {
    return new Response('submission_id, title, description required', { status: 400 });
  }

  const sub = (await sbSelect(env, 'hir_submissions', {
    id: `eq.${submission_id}`,
    select: 'id,status,body_audio_url,body_audio_anon_url,anon,duration_seconds',
    limit: '1',
  }))[0];
  if (!sub) return new Response('submission not found', { status: 404 });

  // Anon flow uses the swapped audio if available; otherwise the raw body.
  const sourceUrl = (sub.anon && sub.body_audio_anon_url) ? sub.body_audio_anon_url : sub.body_audio_url;
  if (!sourceUrl) return new Response('submission has no audio', { status: 400 });

  // Race guard: flip status='ready' → 'publishing' as a conditional
  // PATCH and use the affected-row count as the gate. Two parallel
  // publishes can't both succeed: only the first one matches the
  // 'ready' filter; the second sees status='publishing' and gets
  // 0 rows back. No double-render.
  const claim = await sbUpdate(env, 'hir_submissions',
    { id: submission_id, status: 'ready' },
    { status: 'publishing' });
  if (!claim.length) {
    return new Response(JSON.stringify({ error: 'submission is not in ready state', current: sub.status }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  }

  const guid = crypto.randomUUID();
  const row = await sbInsert(env, 'hir_episodes', {
    submission_id,
    title,
    description,
    source_audio_url: sourceUrl,
    audio_url: null,                  // filled in by the publish cron
    audio_size_bytes: null,
    audio_duration_seconds: sub.duration_seconds || null,
    audio_mime_type: 'audio/mpeg',
    episode_number: episode_number || null,
    season: season || null,
    guid,
    is_explicit: is_explicit !== false,
    processing_state: 'pending',
  });

  return new Response(JSON.stringify(row), {
    headers: { 'content-type': 'application/json' },
  });
}
