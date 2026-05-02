// Pool of hold-music tracks. The Twilio anon flow picks a random one
// per call so the wait doesn't feel like the same loop every time.
// Pool lives at hackersirl-audio/hold-music/track-{1..5}.mp3.

const POOL_SIZE = 5;

export function holdMusicUrl(env) {
  if (env.HOLD_MUSIC_URL) return env.HOLD_MUSIC_URL; // env override wins
  const n = 1 + Math.floor(Math.random() * POOL_SIZE);
  return `${env.SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/hold-music/track-${n}.mp3`;
}
