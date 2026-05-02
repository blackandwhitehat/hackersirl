// Admin re-renders the host's "Up next: …" intro line for a single
// submission. Takes the edited text + optional voice_id, runs ElevenLabs
// TTS in the presenter voice (env.ELEVENLABS_VOICE_PRESENTER unless
// overridden), uploads to handle-intro/<id>.mp3, persists the new text
// + clears preview_input_hash + nulls input_hash on the linked episode
// so the publish cron auto-rebuilds the final mix.
//
// POST { submission_id, text, voice_id? }

import { sbSelect, sbUpdate, sbStorageUpload } from '../../_lib/supabase.js';
import { isAdmin } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!(await isAdmin(request, env))) return new Response('forbidden', { status: 403 });
  const { submission_id, text, voice_id } = await request.json().catch(() => ({}));
  if (!submission_id) return new Response('submission_id required', { status: 400 });
  if (!text || text.trim().length < 5) return new Response('text required (min 5 chars)', { status: 400 });
  if (!env.ELEVENLABS_API_KEY) return new Response('elevenlabs not configured', { status: 503 });

  const trimmed = text.trim().slice(0, 600);
  const vid = voice_id || env.ELEVENLABS_VOICE_PRESENTER || env.ELEVENLABS_VOICE_ANCHOR;
  if (!vid) return new Response('no presenter voice configured', { status: 503 });

  const elResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: trimmed,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.30, use_speaker_boost: true },
    }),
  });
  if (!elResp.ok) {
    const err = await elResp.text();
    console.error(`intro-render EL ${elResp.status}: ${err.slice(0, 300)}`);
    return new Response('upstream tts error', { status: 502 });
  }
  const buf = new Uint8Array(await elResp.arrayBuffer());

  const url = await sbStorageUpload(env, 'hackersirl-audio', `handle-intro/${submission_id}.mp3`, buf, 'audio/mpeg');

  // Persist the new text + clear preview cache so the publish cron
  // detects the submission as stale and re-renders.
  await sbUpdate(env, 'hir_submissions', { id: submission_id }, {
    handle_intro_url: url,
    handle_intro_text: trimmed,
    preview_audio_url: null,
    preview_input_hash: null,
  });

  // Same for any linked episode — clear the episode hash so its final
  // mix gets rebuilt with the updated host intro.
  const eps = await sbSelect(env, 'hir_episodes', {
    submission_id: `eq.${submission_id}`, select: 'id', limit: '5',
  });
  for (const ep of eps) {
    await sbUpdate(env, 'hir_episodes', { id: ep.id }, { input_hash: null });
  }

  return new Response(JSON.stringify({ ok: true, url, episodes_invalidated: eps.length }), {
    headers: { 'content-type': 'application/json' },
  });
}
