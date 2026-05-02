// Configured ElevenLabs voice slots — exposed so the admin UI can
// populate the voice picker without hardcoding IDs in the bundle.
// Slots are read from env at request time so rotating/swapping a
// voice is a config change, not a deploy.

import { isAdmin } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  if (!(await isAdmin(request, env))) return new Response('forbidden', { status: 403 });
  const voices = [
    { key: 'operator',  label: 'Synthetic operator (robotic, smooth)', id: env.ELEVENLABS_VOICE_OPERATOR  || null },
    { key: 'trucker',   label: 'Retro machine (1950s sci-fi)',          id: env.ELEVENLABS_VOICE_TRUCKER   || null },
    { key: 'anchor',    label: 'AI presenter (calm, futuristic)',       id: env.ELEVENLABS_VOICE_ANCHOR    || null },
    { key: 'presenter', label: 'Show presenter (intro voice)',          id: env.ELEVENLABS_VOICE_PRESENTER || env.ELEVENLABS_VOICE_ANCHOR || null },
  ].filter(v => v.id);
  return new Response(JSON.stringify({ voices }), {
    headers: { 'content-type': 'application/json' },
  });
}
