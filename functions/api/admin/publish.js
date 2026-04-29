// Publish a submission as an episode. Body: { submission_id, title,
// description, episode_number?, season? }. Copies the audio (anon
// version if anon, otherwise raw body) into hackersirl-audio/episodes/,
// inserts an hir_episodes row, and flips the submission status.

import { sbSelect, sbInsert, sbUpdate, sbStorageUpload } from '../../_lib/supabase.js';

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
  const body = await request.json();
  const { submission_id, title, description, episode_number, season, is_explicit } = body || {};
  if (!submission_id || !title || !description) {
    return new Response('submission_id, title, description required', { status: 400 });
  }
  const sub = (await sbSelect(env, 'hir_submissions', {
    id: `eq.${submission_id}`,
    select: 'id,body_audio_url,body_audio_anon_url,anon,duration_seconds',
    limit: '1',
  }))[0];
  if (!sub) return new Response('submission not found', { status: 404 });

  const sourceUrl = sub.anon ? sub.body_audio_anon_url : sub.body_audio_url;
  if (!sourceUrl) return new Response('submission has no audio', { status: 400 });

  // Re-host into the canonical episodes/ path so the RSS link is
  // stable independent of the submission/anon paths.
  const audioBuf = new Uint8Array(await (await fetch(sourceUrl)).arrayBuffer());
  const guid = crypto.randomUUID();
  const epUrl = await sbStorageUpload(env, 'hackersirl-audio', `episodes/${guid}.mp3`, audioBuf, 'audio/mpeg');

  const row = await sbInsert(env, 'hir_episodes', {
    submission_id,
    title,
    description,
    audio_url: epUrl,
    audio_size_bytes: audioBuf.byteLength,
    audio_duration_seconds: sub.duration_seconds || null,
    audio_mime_type: 'audio/mpeg',
    episode_number: episode_number || null,
    season: season || null,
    guid,
    is_explicit: is_explicit !== false,
  });
  await sbUpdate(env, 'hir_submissions', { id: submission_id }, { status: 'published' });
  return new Response(JSON.stringify(row), {
    headers: { 'content-type': 'application/json' },
  });
}
