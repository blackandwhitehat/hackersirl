// ElevenLabs Speech-to-Speech client. Given input audio bytes and a
// target voice ID, returns the same speech rendered in that voice.
// Quality is high enough that callers can use this for actual anon.
//
// Voice catalog: the on-call menu offers three persona slots; the
// actual ElevenLabs voice ID for each slot is set via env so we can
// swap voices without redeploying. Defaults are placeholders that
// must be filled in by the deploy step (see scripts/seed-voices.js).

export const ELEVENLABS_VOICES = {
  operator: { label: 'the operator',   elevenlabsVoiceId: process.env?.ELEVENLABS_VOICE_OPERATOR || null },
  trucker:  { label: 'the trucker',    elevenlabsVoiceId: process.env?.ELEVENLABS_VOICE_TRUCKER  || null },
  anchor:   { label: 'the news anchor', elevenlabsVoiceId: process.env?.ELEVENLABS_VOICE_ANCHOR || null },
};

// Resolve voice IDs against the runtime env (Pages Functions pass env
// in via the request handler arg, not via process.env).
export function resolveVoice(env, voiceKey) {
  const map = {
    operator: env.ELEVENLABS_VOICE_OPERATOR,
    trucker:  env.ELEVENLABS_VOICE_TRUCKER,
    anchor:   env.ELEVENLABS_VOICE_ANCHOR,
  };
  return map[voiceKey] || map.operator;
}

// Run input audio through Speech-to-Speech and return swapped audio
// as a Uint8Array (mp3-encoded by default — eleven_multilingual_sts_v2
// returns mp3 if you ask for it).
export async function swapVoice(env, audioBuffer, voiceId, opts = {}) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not configured');
  if (!voiceId) throw new Error('voiceId required');
  const url = `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const fd = new FormData();
  fd.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'in.mp3');
  fd.append('model_id', opts.modelId || 'eleven_multilingual_sts_v2');
  fd.append('voice_settings', JSON.stringify({
    stability: 0.5,
    similarity_boost: 0.85,
    style: 0,
    use_speaker_boost: false,
  }));
  fd.append('remove_background_noise', 'true');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    body: fd,
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`ElevenLabs ${r.status}: ${errText.slice(0, 200)}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}
