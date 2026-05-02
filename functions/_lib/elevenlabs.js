// ElevenLabs Speech-to-Speech client. Given input audio bytes and a
// target voice ID, returns the same speech rendered in that voice.
// Quality is high enough that callers can use this for actual anon.
//
// Voice catalog: three persona slots offered to anon callers. The
// labels are user-facing and used in the IVR menu prompts; the actual
// ElevenLabs voice IDs come from runtime env (Pages Functions pass
// env into each handler — there is no `process` global on Workers).

// Voice-changer style anonymity voices. Each is unmistakably synthetic
// so the listener knows the caller is disguised. See env for current
// IDs (ELEVENLABS_VOICE_OPERATOR/TRUCKER/ANCHOR) — pick is intentional:
//   operator → smooth genderless mechanical
//   trucker  → retro 1950s sci-fi computer
//   anchor   → calm futuristic AI
export const VOICE_LABELS = {
  operator: 'the synthetic operator',
  trucker:  'the retro machine',
  anchor:   'the AI presenter',
};

// Resolve a slot key to the configured ElevenLabs voice ID.
export function resolveVoice(env, voiceKey) {
  const map = {
    operator: env.ELEVENLABS_VOICE_OPERATOR,
    trucker:  env.ELEVENLABS_VOICE_TRUCKER,
    anchor:   env.ELEVENLABS_VOICE_ANCHOR,
  };
  return map[voiceKey] || map.operator;
}

// Run input audio through Speech-to-Speech and return swapped audio
// as a Uint8Array (mp3-encoded by default).
//
// Voice settings tuned for ANONYMITY — we want the output to sound
// like the target persona, not like the source caller. The previous
// settings (stability 0.5, similarity_boost 0.85, style 0,
// use_speaker_boost off) preserved too much of the caller's prosody
// and timbre, so the output still sounded recognizably like them.
//
//   stability         high  → suppresses source's natural variations
//   similarity_boost  high  → push hard toward target voice
//   style             >0    → exaggerate target voice's traits
//   use_speaker_boost true  → enhance the target's vocal print
//
// Net effect: the source's words/timing carry over; the source's
// voice does not.
// Speech-to-text via ElevenLabs Scribe. Returns the spoken text from
// the audio buffer. Used for live anon-mode transcription so we can
// then TTS it back in the target voice (true voice replacement).
export async function transcribe(env, audioBuffer) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not configured');
  const fd = new FormData();
  fd.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'in.mp3');
  fd.append('model_id', 'scribe_v1');
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    body: fd,
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`ElevenLabs scribe ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  return (data.text || '').trim();
}

// TTS — render text in a specific voice, return MP3 bytes.
export async function ttsText(env, voiceId, text, opts = {}) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not configured');
  if (!voiceId) throw new Error('voiceId required');
  if (!text) throw new Error('text required');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: text.slice(0, 5000),
      model_id: opts.modelId || 'eleven_turbo_v2_5',
      voice_settings: opts.voiceSettings || {
        stability: 0.55, similarity_boost: 0.85, style: 0.20, use_speaker_boost: true,
      },
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`ElevenLabs tts ${r.status}: ${errText.slice(0, 200)}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

// Voice Isolator — strips background noise, leaves clean voice.
// Returns isolated MP3 bytes. Min input length ~4.6s; for shorter
// clips, callers should fall back to the original audio.
export async function isolateVoice(env, audioBuffer) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not configured');
  const fd = new FormData();
  fd.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'in.mp3');
  const r = await fetch('https://api.elevenlabs.io/v1/audio-isolation', {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    body: fd,
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`ElevenLabs isolate ${r.status}: ${errText.slice(0, 200)}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

export async function swapVoice(env, audioBuffer, voiceId, opts = {}) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not configured');
  if (!voiceId) throw new Error('voiceId required');
  const url = `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const fd = new FormData();
  fd.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'in.mp3');
  fd.append('model_id', opts.modelId || 'eleven_english_sts_v2');
  fd.append('voice_settings', JSON.stringify({
    stability: 0.85,
    similarity_boost: 0.95,
    style: 0.45,
    use_speaker_boost: true,
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
