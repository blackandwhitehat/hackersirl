// Manage show-wide audio assets: intro, outro, bg_intro, bg_outro,
// phone_tones. The publish cron reads the latest active row of each
// asset_type from hir_show_assets and uses it in the ffmpeg mix.
//
// GET  → list latest active per type
// POST → create new asset:
//   { asset_type, mode: 'tts' | 'upload', text?, voice_id?, audio_url?,
//     b64? }
//   tts: server calls ElevenLabs, uploads MP3, inserts row
//   upload: client already-uploaded URL OR base64 payload uploaded by server

import { sbSelect, sbInsert, sbUpdate, sbStorageUpload } from '../../_lib/supabase.js';
import { isAdmin } from '../../_lib/auth.js';

const TYPES = ['intro', 'outro', 'bg_intro', 'bg_outro', 'phone_tones'];

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return new Response('forbidden', { status: 403 });
  // One row per type — latest active.
  const rows = await sbSelect(env, 'hir_show_assets', {
    active: 'eq.true',
    select: 'id,asset_type,audio_url,text_source,voice_id,size_bytes,duration_seconds,created_at',
    order: 'created_at.desc',
    limit: '50',
  });
  const byType = {};
  for (const r of rows) if (!byType[r.asset_type]) byType[r.asset_type] = r;
  return new Response(JSON.stringify({ assets: byType, types: TYPES }), {
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return new Response('forbidden', { status: 403 });
  const ct = request.headers.get('content-type') || '';

  let assetType, mode, text, voiceId, uploadedBuf, uploadedMime;

  if (ct.includes('multipart/form-data')) {
    const fd = await request.formData();
    assetType = String(fd.get('asset_type') || '');
    mode = String(fd.get('mode') || 'upload');
    text = fd.get('text') ? String(fd.get('text')) : null;
    voiceId = fd.get('voice_id') ? String(fd.get('voice_id')) : null;
    const f = fd.get('file');
    if (f && typeof f !== 'string') {
      uploadedBuf = new Uint8Array(await f.arrayBuffer());
      uploadedMime = f.type || 'audio/mpeg';
    }
  } else {
    const body = await request.json();
    ({ asset_type: assetType, mode, text, voice_id: voiceId } = body);
  }

  if (!TYPES.includes(assetType)) return new Response('bad asset_type', { status: 400 });
  if (!['tts', 'upload'].includes(mode))  return new Response('bad mode', { status: 400 });

  // Accept-list of audio MIMEs for upload mode. Bucket is public, so
  // an HTML/SVG/JS body would render with the stored content-type and
  // become stored XSS. Reject anything that isn't audio.
  const ALLOWED_AUDIO = new Set(['audio/webm','audio/ogg','audio/mp4','audio/m4a','audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/mp3']);
  // Cap on TTS text to bound EL spend per request.
  const TTS_MAX_CHARS = 5000;

  let audioUrl, sizeBytes = 0;

  if (mode === 'tts') {
    if (!text) return new Response('text required for tts mode', { status: 400 });
    if (!env.ELEVENLABS_API_KEY) return new Response('ELEVENLABS_API_KEY not configured', { status: 500 });
    const vid = voiceId || env.ELEVENLABS_VOICE_OPERATOR || 'nPczCjzI2devNBz1zQrb';
    const clipped = text.slice(0, TTS_MAX_CHARS);
    const elResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: clipped, model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.30, use_speaker_boost: true },
      }),
    });
    if (!elResp.ok) {
      // Don't leak EL upstream error text to the client.
      const err = await elResp.text();
      console.error(`show-assets ElevenLabs ${elResp.status}: ${err.slice(0, 500)}`);
      return new Response('upstream tts error', { status: 502 });
    }
    const buf = new Uint8Array(await elResp.arrayBuffer());
    sizeBytes = buf.byteLength;
    const key = `show/${assetType}-${Date.now()}.mp3`;
    audioUrl = await sbStorageUpload(env, 'hackersirl-audio', key, buf, 'audio/mpeg');
    voiceId = vid;
    text = clipped;
  } else {
    // upload mode — file came as multipart
    if (!uploadedBuf) return new Response('file required for upload mode', { status: 400 });
    const mimeKey = (uploadedMime || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_AUDIO.has(mimeKey)) {
      return new Response(JSON.stringify({ error: `audio MIME required (got: ${mimeKey || 'unknown'})` }), {
        status: 415, headers: { 'content-type': 'application/json' },
      });
    }
    sizeBytes = uploadedBuf.byteLength;
    const key = `show/${assetType}-${Date.now()}.mp3`;
    // Always upload as audio/mpeg regardless of source MIME so the
    // public bucket only serves it as audio.
    audioUrl = await sbStorageUpload(env, 'hackersirl-audio', key, uploadedBuf, 'audio/mpeg');
  }

  // Deactivate previous version of this asset_type so the cron only
  // sees the new one.
  await sbUpdate(env, 'hir_show_assets', { asset_type: assetType, active: 'true' }, { active: false });

  const row = await sbInsert(env, 'hir_show_assets', {
    asset_type: assetType,
    audio_url: audioUrl,
    text_source: mode === 'tts' ? text : null,
    voice_id: mode === 'tts' ? voiceId : null,
    size_bytes: sizeBytes,
    active: true,
  });

  return new Response(JSON.stringify(row), {
    headers: { 'content-type': 'application/json' },
  });
}
