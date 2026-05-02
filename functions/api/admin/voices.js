// Voice picker catalog — split into two groups so the admin UI can
// surface the right voices for the right slot.
//
// `host` = natural human voices for intro/outro/handle-intro narration.
//          These are well-known ElevenLabs preset voices that sound
//          like a podcast host, not a voice changer.
// `synth` = unmistakably synthetic disguise voices for anon callers.
//           Configured per-slot via env (ELEVENLABS_VOICE_*) so we can
//           rotate without deploying.

import { isAdmin } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  if (!(await isAdmin(request, env))) return new Response('forbidden', { status: 403 });

  const synth = [
    { key: 'operator',  label: 'Synthetic operator (robotic, smooth)', id: env.ELEVENLABS_VOICE_OPERATOR  || null },
    { key: 'trucker',   label: 'Retro machine (1950s sci-fi)',          id: env.ELEVENLABS_VOICE_TRUCKER   || null },
    { key: 'anchor',    label: 'AI presenter (calm, futuristic)',       id: env.ELEVENLABS_VOICE_ANCHOR    || null },
  ].filter(v => v.id);

  // Curated ElevenLabs preset voices — natural narration timbre,
  // good for podcast intro/outro and for the show host re-speaking
  // a caller's handle. Expand by adding to this list; no env needed.
  const host = [
    { key: 'brian',     label: 'Brian (deep male, warm narrator)',      id: 'nPczCjzI2devNBz1zQrb' },
    { key: 'antoni',    label: 'Antoni (warm male)',                    id: 'ErXwobaYiN019PkySvjV' },
    { key: 'adam',      label: 'Adam (deep male, classic default)',     id: 'pNInz6obpgDQGcFmaJgB' },
    { key: 'daniel',    label: 'Daniel (British male, news-style)',     id: 'onwK4e9ZLuTAKqWW03F9' },
    { key: 'george',    label: 'George (soft male narrator)',           id: 'JBFqnCBsd6RMkjVDRZzb' },
    { key: 'liam',      label: 'Liam (American male, clean)',           id: 'TX3LPaxmHKxFdv7VOQHJ' },
    { key: 'rachel',    label: 'Rachel (calm female narrator)',         id: '21m00Tcm4TlvDq8ikWAM' },
    { key: 'bella',     label: 'Bella (soft female)',                   id: 'EXAVITQu4vr4xnSDxMaL' },
    { key: 'charlotte', label: 'Charlotte (English female)',            id: 'XB0fDUnXU5powFXDhCwa' },
    { key: 'lily',      label: 'Lily (warm female)',                    id: 'pFZP5JQG7iQjIQuC4Bku' },
  ];

  // Flat list (host first, then synth) for backwards-compat with the
  // old single-list shape the admin UI expects today. The new `groups`
  // field carries the split for future UI work.
  const voices = [...host, ...synth];

  return new Response(JSON.stringify({
    voices,
    groups: { host, synth },
  }), {
    headers: { 'content-type': 'application/json' },
  });
}
