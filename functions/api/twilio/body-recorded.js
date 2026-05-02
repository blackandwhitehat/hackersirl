// Body recording finished. Save the URL, drop into the review menu.
//
// Re-record case: the caller hit "2" in the review menu, recorded again,
// and now this fires with a fresh RecordingUrl. We MUST invalidate
// everything derived from the previous recording — otherwise the next
// anon-process call would see the stale body_audio_anon_url and play
// back the OLD scrambled audio. Same for preview/transcript/etc., which
// the post-call cron will regenerate from the new recording.

import { twimlResponse, twilioForm, verifyTwilioSignature } from '../../_lib/twiml.js';
import { sbUpdate } from '../../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  const params = await twilioForm(request);
  if (!(await verifyTwilioSignature(request, env, params))) {
    return new Response('signature invalid', { status: 403 });
  }
  await sbUpdate(env, 'hir_submissions', {
    twilio_call_sid: params.CallSid,
    status: 'not.in.(published,rejected,publishing,processing)',
  }, {
    body_audio_url: params.RecordingUrl ? `${params.RecordingUrl}.mp3` : null,
    duration_seconds: parseInt(params.RecordingDuration, 10) || null,
    // Invalidate everything derived from the previous body recording.
    // Cron + anon-process will rebuild from the fresh RecordingUrl.
    body_audio_anon_url: null,
    preview_audio_url: null,
    preview_input_hash: null,
    transcript: null,
    suggested_title: null,
    suggested_description: null,
    show_notes: null,
    handle_intro_url: null,
    handle_intro_text: null,
  });
  return twimlResponse(`<Redirect method="POST">/api/twilio/review</Redirect>`);
}
