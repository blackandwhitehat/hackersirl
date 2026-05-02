#!/usr/bin/env bash
# Render the 3 anon voice samples for the Twilio voice-preview menu.
# Each sample is a short TTS clip in that persona's voice so the
# caller can audition it before committing.

set -e
EL_KEY="$(cat ~/.claude/keys/elevenlabs-api-key)"
SUPABASE_URL="https://ltaaiiqtrmlqrzhglxob.supabase.co"
set -a; source ~/.claude/cron/.env; set +a
SK="$SUPABASE_SERVICE_ROLE_KEY"

mkdir -p /tmp/voice-samples
cd /tmp/voice-samples

declare -a SAMPLES
SAMPLES=(
  "operator|nPczCjzI2devNBz1zQrb|This is how you'll sound as the operator. Deep, calm, and a little tired. Like the late-shift control room voice on the other end of the wire."
  "trucker|N2lVS1w4EtoT3dr4eOWO|This is how you'll sound as the trucker. Husky, dry, the kind of voice you'd hear coming over CB at three in the morning."
  "anchor|onwK4e9ZLuTAKqWW03F9|This is how you'll sound as the news anchor. Steady, broadcast crisp, like someone reading the bulletin from a soundproofed room."
)

for entry in "${SAMPLES[@]}"; do
  IFS='|' read -r name vid text <<< "$entry"
  echo "→ $name ($vid)"
  curl -sS -X POST "https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=mp3_44100_128" \
    -H "xi-api-key: $EL_KEY" \
    -H "content-type: application/json" \
    -d "$(jq -nc --arg t "$text" '{text:$t, model_id:"eleven_turbo_v2_5", voice_settings:{stability:0.55, similarity_boost:0.85, style:0.30, use_speaker_boost:true}}')" \
    -o "${name}.mp3"
  echo "  $(stat -f%z ${name}.mp3) bytes"

  curl -sS -X POST "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/voice-samples/${name}.mp3" \
    -H "apikey: ${SK}" -H "authorization: Bearer ${SK}" \
    -H "x-upsert: true" -H "content-type: audio/mpeg" \
    --data-binary "@${name}.mp3" > /dev/null
  echo "  uploaded"
done
