// List submissions in the admin queue, newest first. Gated by
// Cloudflare Access — the JWT is forwarded as Cf-Access-Jwt-Assertion
// and only requests where Access has authenticated Panda's email
// reach this handler. Plus a fallback bearer-token check for local
// testing.

import { sbSelect } from '../../_lib/supabase.js';

function authorized(request, env) {
  const accessEmail = request.headers.get('cf-access-authenticated-user-email');
  if (accessEmail && env.ADMIN_EMAIL && accessEmail.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()) {
    return true;
  }
  const auth = request.headers.get('authorization') || '';
  if (env.ADMIN_BEARER && auth === `Bearer ${env.ADMIN_BEARER}`) return true;
  return false;
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return new Response('forbidden', { status: 403 });
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'ready,processing,recording,publishing,published';
  const params = {
    status: `in.(${status})`,
    select: 'id,handle,handle_audio_url,body_audio_url,body_audio_anon_url,anon,anon_voice_id,duration_seconds,transcript,suggested_title,suggested_description,status,created_at,preview_audio_url,preview_size_bytes,preview_duration_seconds,hir_episodes(id,title,description,episode_number,season,audio_url,audio_size_bytes,audio_duration_seconds,processing_state,published_at,guid)',
    order: 'created_at.desc',
    limit: '100',
  };
  const rows = await sbSelect(env, 'hir_submissions', params);
  return new Response(JSON.stringify(rows), {
    headers: { 'content-type': 'application/json' },
  });
}
