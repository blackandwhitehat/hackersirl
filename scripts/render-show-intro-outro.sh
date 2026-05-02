#!/usr/bin/env bash
# Render Hackers IRL show intro + outro via ElevenLabs (Brian voice,
# matches /call IVR for show-wide consistency).
# Re-runnable any time we want to change the script.

set -e

EL_KEY="$(cat ~/.claude/keys/elevenlabs-api-key)"
VOICE_ID="nPczCjzI2devNBz1zQrb"   # Brian
SUPABASE_URL="https://ltaaiiqtrmlqrzhglxob.supabase.co"
set -a; source ~/.claude/cron/.env; set +a
SUPABASE_KEY="$SUPABASE_SERVICE_ROLE_KEY"

mkdir -p /tmp/show-render
cd /tmp/show-render

render() {
  local name="$1"; local text="$2"
  echo "→ $name"
  curl -sS -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128" \
    -H "xi-api-key: $EL_KEY" \
    -H "content-type: application/json" \
    -d "$(jq -nc --arg t "$text" '{
      text:$t,
      model_id:"eleven_turbo_v2_5",
      voice_settings:{stability:0.55, similarity_boost:0.85, style:0.30, use_speaker_boost:true}
    }')" \
    -o "${name}.mp3"
  echo "   $(stat -f%z ${name}.mp3 2>/dev/null) bytes"
}

upload() {
  local name="$1"
  curl -sS -X POST "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/show/${name}.mp3" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "authorization: Bearer ${SUPABASE_KEY}" \
    -H "x-upsert: true" \
    -H "content-type: audio/mpeg" \
    --data-binary "@${name}.mp3"
  echo
  echo "   uploaded $name.mp3"
}

INTRO_TEXT="You're listening to Hackers IRL. We're the people the news pretends are a single character. We are not. We pop shells, walk our dogs, fight with our printers, and somehow ship the work. This show is voicemails. Brain dumps from our side of the wire about whatever's on our minds. The line stays open. Here's today's transmission."

OUTRO_TEXT="That was Hackers IRL. The line stays open, twenty-four seven. Dial nine-oh-four, nine-one-five, H A C K — that's 904-915-4225 — or jack into hackers I R L dot com slash call to record from any browser. Up to ten minutes. Stay anonymous and the box scrambles your voice before anyone hears it. We pick the ones that feel right. Pick up the phone. End of transmission."

render intro "$INTRO_TEXT"
render outro "$OUTRO_TEXT"

upload intro
upload outro

echo ""
echo "Public URLs:"
echo "  ${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/show/intro.mp3"
echo "  ${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/show/outro.mp3"
