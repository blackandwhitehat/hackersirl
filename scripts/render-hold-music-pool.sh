#!/usr/bin/env zsh
# Render a pool of 5 cyberpunk/phreaker hold-music variants. Caller
# gets a random one per call so the wait doesn't feel like a loop.

set -e
SR=44100
DUR=45
SUPABASE_URL="https://ltaaiiqtrmlqrzhglxob.supabase.co"
set -a; source ~/.claude/cron/.env; set +a
SK="$SUPABASE_SERVICE_ROLE_KEY"

mkdir -p /tmp/hold-pool
cd /tmp/hold-pool

upload() {
  local n="$1"
  curl -s -X POST "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/hold-music/track-${n}.mp3" \
    -H "apikey: $SK" -H "authorization: Bearer $SK" -H "x-upsert: true" -H "content-type: audio/mpeg" \
    --data-binary "@track-${n}.mp3" > /dev/null
  echo "  uploaded track-${n}.mp3 ($(stat -f%z track-${n}.mp3) bytes)"
}

# Track 1 — low ambient pad (current vibe)
echo "→ track-1 ambient pad"
ffmpeg -y -f lavfi \
  -i "aevalsrc='0.06*sin(110*2*PI*t)+0.045*sin(165*2*PI*t)+0.025*sin(220*2*PI*t)+0.04*sin(110.4*2*PI*t)':d=${DUR}:sample_rate=${SR}" \
  -af "lowpass=f=900,afade=in:st=0:d=2,afade=out:st=$((DUR-2)):d=2,volume=0.6" \
  -ac 1 -b:a 128k -c:a libmp3lame track-1.mp3 -hide_banner -loglevel error
upload 1

# Track 2 — minor-key drone (deeper, more ominous)
echo "→ track-2 minor drone"
ffmpeg -y -f lavfi \
  -i "aevalsrc='0.05*sin(82.4*2*PI*t)+0.04*sin(123.5*2*PI*t)+0.03*sin(164.8*2*PI*t)+0.025*sin(98*2*PI*t)':d=${DUR}:sample_rate=${SR}" \
  -af "lowpass=f=700,afade=in:st=0:d=2,afade=out:st=$((DUR-2)):d=2,volume=0.6" \
  -ac 1 -b:a 128k -c:a libmp3lame track-2.mp3 -hide_banner -loglevel error
upload 2

# Track 3 — pulsing heartbeat (slow tempo, dark)
echo "→ track-3 pulse"
ffmpeg -y -f lavfi \
  -i "aevalsrc='(0.5+0.5*sin(0.4*2*PI*t))*0.08*sin(60*2*PI*t)+0.04*sin(120*2*PI*t)+0.02*sin(180*2*PI*t)':d=${DUR}:sample_rate=${SR}" \
  -af "lowpass=f=600,afade=in:st=0:d=2,afade=out:st=$((DUR-2)):d=2,volume=0.7" \
  -ac 1 -b:a 128k -c:a libmp3lame track-3.mp3 -hide_banner -loglevel error
upload 3

# Track 4 — modem nostalgia (subtle dialup squeal underneath ambient bed)
echo "→ track-4 modem bed"
ffmpeg -y -f lavfi \
  -i "aevalsrc='0.05*sin(110*2*PI*t)+0.04*sin(220*2*PI*t)+0.015*sin(2100*2*PI*t)*sin(0.3*2*PI*t)+0.012*sin(1500*2*PI*t)*sin(0.2*2*PI*t)':d=${DUR}:sample_rate=${SR}" \
  -af "lowpass=f=2400,afade=in:st=0:d=2,afade=out:st=$((DUR-2)):d=2,volume=0.5" \
  -ac 1 -b:a 128k -c:a libmp3lame track-4.mp3 -hide_banner -loglevel error
upload 4

# Track 5 — filtered noise + tonal (data center aesthetic)
echo "→ track-5 datacenter"
ffmpeg -y -f lavfi -i "anoisesrc=color=brown:duration=${DUR}:sample_rate=${SR}:amplitude=0.05" \
  -f lavfi -i "aevalsrc='0.04*sin(82*2*PI*t)+0.03*sin(164*2*PI*t)':d=${DUR}:sample_rate=${SR}" \
  -filter_complex "[0:a]lowpass=f=400[n];[n][1:a]amix=inputs=2:duration=first,afade=in:st=0:d=2,afade=out:st=$((DUR-2)):d=2,volume=0.6[out]" \
  -map "[out]" -ac 1 -b:a 128k -c:a libmp3lame track-5.mp3 -hide_banner -loglevel error
upload 5

echo ""
echo "Pool URLs:"
for n in 1 2 3 4 5; do
  echo "  ${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/hold-music/track-${n}.mp3"
done
