// OpenAI helpers: Whisper transcription + chat-completion for drafting
// episode titles/descriptions. Both gated by OPENAI_API_KEY env var;
// if missing, the endpoints return null and the admin queue just
// surfaces the raw audio with no draft text.

export async function transcribe(env, audioBuffer) {
  if (!env.OPENAI_API_KEY) return null;
  const fd = new FormData();
  fd.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'in.mp3');
  fd.append('model', 'whisper-1');
  fd.append('response_format', 'text');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`whisper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.text();
}

export async function draftEpisodeMeta(env, transcript) {
  if (!env.OPENAI_API_KEY || !transcript) return null;
  const sys = 'You write podcast episode titles and descriptions for "Hackers IRL", a show of casual voicemails from people in the hacking and infosec community talking about their day. Tone: human, warm, curious, never breathless or marketing-y. No em-dashes. Keep titles under 70 characters and descriptions under 240 characters.';
  const user = `Draft a title and a one-paragraph description for this voicemail. Reply as JSON: {"title": "...", "description": "..."}.\n\nTranscript:\n${transcript.slice(0, 6000)}`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content;
  try { return JSON.parse(content); } catch { return null; }
}
