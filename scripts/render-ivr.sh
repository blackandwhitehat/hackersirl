#!/usr/bin/env bash
# Pre-render HackersIRL browser-call IVR prompts via ElevenLabs TTS
# and upload to Supabase Storage at hackersirl-audio/ivr/*.mp3.

set -e

EL_KEY="$(cat ~/.claude/keys/elevenlabs-api-key)"
VOICE_ID="nPczCjzI2devNBz1zQrb"   # Brian — deep operator
SUPABASE_URL="https://ltaaiiqtrmlqrzhglxob.supabase.co"
set -a; source ~/.claude/cron/.env; set +a
SUPABASE_KEY="$SUPABASE_SERVICE_ROLE_KEY"

mkdir -p /tmp/ivr-render
cd /tmp/ivr-render

render() {
  local name="$1"; local text="$2"
  echo "→ $name"
  curl -sS -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128" \
    -H "xi-api-key: $EL_KEY" \
    -H "content-type: application/json" \
    -d "$(jq -nc --arg t "$text" '{text:$t, model_id:"eleven_turbo_v2_5", voice_settings:{stability:0.55, similarity_boost:0.85, style:0.20, use_speaker_boost:true}}')" \
    -o "${name}.mp3"
  echo "   $(stat -f%z ${name}.mp3 2>/dev/null) bytes"
}

upload() {
  local name="$1"
  curl -sS -X POST "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/ivr/${name}.mp3" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "authorization: Bearer ${SUPABASE_KEY}" \
    -H "x-upsert: true" \
    -H "content-type: audio/mpeg" \
    --data-binary "@${name}.mp3"
  echo
  echo "   uploaded ${name}.mp3"
}

render greeting     "Hey, you've reached the Hackers IRL operator log. Brain dump for up to ten minutes about whatever's on your mind."
render menu         "To leave a regular log, press 1. To stay anonymous and have your voice scrambled, press 2."
render anon-confirm "Anonymous mode. Your voice will be scrambled before anyone hears it."
render handle-prompt "Record your handle and what you do, in five seconds, after the tone."
render body-prompt  "Now give us your message. Up to ten minutes. Press the pound key when you're done."
render review-menu  "Press one to hear it back. Two to re-record. Three to send it. Star to hang up."
render submitted    "Got it. Thanks for calling. We'll review and you might hear yourself on an episode soon. Talk to you later."

echo ""
for f in greeting menu anon-confirm handle-prompt body-prompt review-menu submitted; do
  upload "$f"
done

echo ""
echo "Public base: ${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/ivr/"
