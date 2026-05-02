// Browser voicemail submit endpoint. Mirrors the Twilio side of the
// pipeline but takes the audio directly from the caller's browser
// instead of pulling it from Twilio.
//
// Request: multipart/form-data
//   handle_audio  (optional, blob)
//   body_audio    (required, blob)
//   anon          ('1' or '0')
//   anon_voice_id (optional, defaults to 'operator')
//   source        ('web')
//
// Response: { id }
//
// Side effects:
//   - upload both blobs to Supabase Storage
//   - insert hir_submissions row referencing the storage URLs
//   - kick off /api/process via waitUntil to handle anon swap (if anon)
//     and to mark status='ready' so the local cron can transcribe + draft

import { sbInsert, sbStorageUpload } from '../../_lib/supabase.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024;   // 25MB ~= 12 min @ 256kbps mono opus
const MAX_HANDLE_BYTES = 1 * 1024 * 1024;  // 1MB

function uuid() {
  // Workers runtime has crypto.randomUUID
  return crypto.randomUUID();
}

function extFromMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4'))  return 'm4a';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('wav'))  return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return 'webm';
}

export async function onRequestPost({ request, env, waitUntil }) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'expected multipart/form-data' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  // Cloudflare Turnstile — gates the submit endpoint against drive-by
  // spam. Fails CLOSED: if TURNSTILE_SECRET is unset (deploy misconfig)
  // we return 503 instead of accepting unprotected submissions.
  if (!env.TURNSTILE_SECRET) {
    console.error('submit: TURNSTILE_SECRET unset — refusing to accept');
    return new Response(JSON.stringify({ error: 'service unavailable' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }
  const tsTok = form.get('cf_turnstile_token');
  if (!tsTok) {
    return new Response(JSON.stringify({ error: 'turnstile token required' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  const ip = request.headers.get('cf-connecting-ip') || '';
  const verifyResp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: tsTok.toString(),
      ...(ip ? { remoteip: ip } : {}),
    }),
  });
  const verify = await verifyResp.json().catch(() => ({}));
  if (!verify.success) {
    return new Response(JSON.stringify({ error: 'turnstile failed', codes: verify['error-codes'] || [] }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }

  const bodyFile = form.get('body_audio');
  const handleFile = form.get('handle_audio');
  const anon = form.get('anon') === '1';
  const anonVoice = (form.get('anon_voice_id') || 'operator').toString();

  // Audio MIME allow-list — the bucket is public, an HTML/SVG/JS blob
  // here would render with whatever content-type we stored, opening
  // stored-XSS. Reject anything that isn't a known audio type.
  const ALLOWED_AUDIO = new Set(['audio/webm','audio/ogg','audio/mp4','audio/m4a','audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/mp3']);
  const checkMime = (f, name) => {
    const t = (f.type || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_AUDIO.has(t)) {
      throw new Response(JSON.stringify({ error: `${name} must be audio (got: ${t || 'unknown'})` }), {
        status: 415, headers: { 'content-type': 'application/json' },
      });
    }
  };

  if (!bodyFile || typeof bodyFile === 'string') {
    return new Response(JSON.stringify({ error: 'body_audio required' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  if (bodyFile.size > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: 'body_audio too large' }), {
      status: 413, headers: { 'content-type': 'application/json' },
    });
  }
  if (handleFile && typeof handleFile !== 'string' && handleFile.size > MAX_HANDLE_BYTES) {
    return new Response(JSON.stringify({ error: 'handle_audio too large' }), {
      status: 413, headers: { 'content-type': 'application/json' },
    });
  }
  try { checkMime(bodyFile, 'body_audio'); } catch (e) { if (e instanceof Response) return e; throw e; }
  if (handleFile && typeof handleFile !== 'string' && handleFile.size > 0) {
    try { checkMime(handleFile, 'handle_audio'); } catch (e) { if (e instanceof Response) return e; throw e; }
  }

  const id = uuid();
  const bodyExt = extFromMime(bodyFile.type);
  const handleExt = handleFile && typeof handleFile !== 'string' ? extFromMime(handleFile.type) : null;

  // Upload to Storage
  const bodyBuf = new Uint8Array(await bodyFile.arrayBuffer());
  const bodyUrl = await sbStorageUpload(
    env,
    'hackersirl-audio',
    `body/${id}.${bodyExt}`,
    bodyBuf,
    bodyFile.type || 'application/octet-stream'
  );

  let handleUrl = null;
  if (handleFile && typeof handleFile !== 'string' && handleFile.size > 0) {
    const hBuf = new Uint8Array(await handleFile.arrayBuffer());
    handleUrl = await sbStorageUpload(
      env,
      'hackersirl-audio',
      `handle/${id}.${handleExt}`,
      hBuf,
      handleFile.type || 'application/octet-stream'
    );
  }

  // Insert submission row. status='ready' means the audio is hosted
  // and the local cron can pick it up for transcribe + draft. Anon
  // swap, if requested, fires below via /api/process.
  const row = await sbInsert(env, 'hir_submissions', {
    id,
    twilio_call_sid: `web-${id}`,
    handle_audio_url: handleUrl,
    body_audio_url: bodyUrl,
    anon,
    anon_voice_id: anon ? anonVoice : null,
    status: 'ready',
  });

  // Kick anon swap async if requested. /api/process is INTERNAL_SECRET
  // gated and will rehost (no-op since already in Storage) + run the
  // ElevenLabs S2S into body_audio_anon_url.
  if (anon && env.ELEVENLABS_API_KEY) {
    const baseUrl = new URL(request.url).origin;
    waitUntil(fetch(`${baseUrl}/api/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': env.INTERNAL_SECRET || '',
      },
      body: JSON.stringify({ call_sid: `web-${id}` }),
    }).catch(() => {}));
  }

  return new Response(JSON.stringify({ id }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
