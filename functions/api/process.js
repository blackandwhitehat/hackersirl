// Background processor — pull a submission's recordings off Twilio,
// re-host in Supabase Storage, run anon swap if needed, transcribe,
// draft a title/description. All non-blocking on the caller's side
// (called via waitUntil from /api/twilio/submit).
//
// Protected by INTERNAL_SECRET so external callers can't trigger it.

import { sbSelect, sbUpdate, sbStorageUpload } from '../_lib/supabase.js';
import { swapVoice, resolveVoice } from '../_lib/elevenlabs.js';
import { transcribe, draftEpisodeMeta } from '../_lib/openai.js';

export async function onRequestPost({ request, env }) {
  if ((request.headers.get('x-internal-secret') || '') !== (env.INTERNAL_SECRET || '__missing__')) {
    return new Response('forbidden', { status: 403 });
  }
  const { call_sid } = await request.json();
  if (!call_sid) return new Response('call_sid required', { status: 400 });

  const sub = (await sbSelect(env, 'hir_submissions', {
    twilio_call_sid: `eq.${call_sid}`,
    select: 'id,handle_audio_url,body_audio_url,body_audio_anon_url,anon,anon_voice_id',
    limit: '1',
  }))[0];
  if (!sub) return new Response('not found', { status: 404 });

  const twilioAuth = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const fetchTwilio = async (url) => {
    const r = await fetch(url, { headers: { authorization: twilioAuth } });
    if (!r.ok) throw new Error(`twilio fetch ${r.status} for ${url}`);
    return new Uint8Array(await r.arrayBuffer());
  };

  // Pull and re-host both legs.
  const updates = {};
  if (sub.handle_audio_url && sub.handle_audio_url.includes('twilio.com')) {
    const buf = await fetchTwilio(sub.handle_audio_url);
    updates.handle_audio_url = await sbStorageUpload(env, 'hackersirl-audio', `handle/${sub.id}.mp3`, buf, 'audio/mpeg');
  }
  let bodyBuf = null;
  if (sub.body_audio_url && sub.body_audio_url.includes('twilio.com')) {
    bodyBuf = await fetchTwilio(sub.body_audio_url);
    updates.body_audio_url = await sbStorageUpload(env, 'hackersirl-audio', `body/${sub.id}.mp3`, bodyBuf, 'audio/mpeg');
  }

  // Anon swap if needed and not already done in-call.
  if (sub.anon && !sub.body_audio_anon_url && bodyBuf && env.ELEVENLABS_API_KEY) {
    try {
      const voiceId = resolveVoice(env, sub.anon_voice_id || 'operator');
      const swapped = await swapVoice(env, bodyBuf, voiceId);
      updates.body_audio_anon_url = await sbStorageUpload(env, 'hackersirl-audio', `anon/${sub.id}.mp3`, swapped, 'audio/mpeg');
    } catch (e) {
      console.error('anon swap failed:', e);
    }
  }

  // Transcribe (use the anon version if anon, since that's what the
  // listener will hear and what the title/desc should map to).
  let transcript = null;
  try {
    const sourceBuf = sub.anon
      ? (updates.body_audio_anon_url ? await fetchUrl(updates.body_audio_anon_url) : null)
      : bodyBuf;
    if (sourceBuf) transcript = await transcribe(env, sourceBuf);
    if (transcript) updates.transcript = transcript;
  } catch (e) {
    console.error('transcribe failed:', e);
  }

  // Draft title + description.
  if (transcript) {
    try {
      const meta = await draftEpisodeMeta(env, transcript);
      if (meta) {
        if (meta.title) updates.suggested_title = meta.title;
        if (meta.description) updates.suggested_description = meta.description;
      }
    } catch (e) {
      console.error('draft meta failed:', e);
    }
  }

  updates.status = 'ready';
  await sbUpdate(env, 'hir_submissions', { id: sub.id }, updates);
  return new Response('ok', { status: 200 });
}

async function fetchUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url);
  return new Uint8Array(await r.arrayBuffer());
}
