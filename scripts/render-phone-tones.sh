#!/usr/bin/env zsh
# Generate the phone-tones intro for HackersIRL episodes:
# pickup → dial tone → DTMF dialing 9-0-4-9-1-5-4-2-2-5 → ringing → pickup.
# Uses pure ffmpeg synthesis, no input audio files.

set -e
WORKDIR=$(mktemp -d /tmp/phone-tones.XXXXXX)
cd "$WORKDIR"

SR=44100
GAP=0.08         # 80ms between digits
DUR_DIAL=1.5     # dial tone
DUR_RING=2.0     # one ring pulse
DUR_OFF=4.0      # silence between rings
DUR_DTMF=0.12

# DTMF row/col Hz pairs (low,high):
typeset -A LOW HIGH
LOW=(  1 697 2 697 3 697 4 770 5 770 6 770 7 852 8 852 9 852 0 941 )
HIGH=( 1 1209 2 1336 3 1477 4 1209 5 1336 6 1477 7 1209 8 1336 9 1477 0 1336 )

# Render a single tone clip
gen_dual() {
  local f1="$1" f2="$2" dur="$3" out="$4"
  ffmpeg -y -f lavfi \
    -i "aevalsrc=0.18*sin(${f1}*2*PI*t)+0.18*sin(${f2}*2*PI*t):duration=${dur}:sample_rate=${SR}" \
    -ac 1 "$out" -hide_banner -loglevel error
}
gen_silence() {
  local dur="$1" out="$2"
  ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=${SR}" -t "$dur" "$out" -hide_banner -loglevel error
}

# 1. Pickup click (700Hz, 60ms)
ffmpeg -y -f lavfi \
  -i "aevalsrc=0.15*sin(700*2*PI*t):duration=0.06:sample_rate=${SR}" \
  -ac 1 pickup.wav -hide_banner -loglevel error
gen_silence 0.3 gap_post_pickup.wav

# 2. Dial tone
gen_dual 350 440 "$DUR_DIAL" dialtone.wav
gen_silence 0.4 gap_post_dial.wav

# 3. DTMF 9-0-4-9-1-5-4-2-2-5
NUMBER="9049154225"
DTMF_FILES=()
for (( i=0; i<${#NUMBER}; i++ )); do
  d="${NUMBER:$i:1}"
  out="dtmf_${i}.wav"
  gen_dual "${LOW[$d]}" "${HIGH[$d]}" "$DUR_DTMF" "$out"
  DTMF_FILES+=("$out")
  gap="gap_${i}.wav"
  gen_silence "$GAP" "$gap"
  DTMF_FILES+=("$gap")
done

gen_silence 0.5 gap_post_dtmf.wav

# 4. Ringing (2 cycles)
gen_dual 440 480 "$DUR_RING" ring.wav
gen_silence "$DUR_OFF" off.wav

# 5. Pickup click at the end (acknowledge connection)
gen_silence 0.2 gap_pre_pickup2.wav
ffmpeg -y -f lavfi \
  -i "aevalsrc=0.15*sin(700*2*PI*t):duration=0.06:sample_rate=${SR}" \
  -ac 1 pickup2.wav -hide_banner -loglevel error

# Concat list — this is the order the listener hears.
{
  echo "file 'pickup.wav'"
  echo "file 'gap_post_pickup.wav'"
  echo "file 'dialtone.wav'"
  echo "file 'gap_post_dial.wav'"
  for f in "${DTMF_FILES[@]}"; do echo "file '$f'"; done
  echo "file 'gap_post_dtmf.wav'"
  echo "file 'ring.wav'"
  echo "file 'off.wav'"
  echo "file 'ring.wav'"
  echo "file 'gap_pre_pickup2.wav'"
  echo "file 'pickup2.wav'"
} > concat.txt

ffmpeg -y -f concat -safe 0 -i concat.txt -ar $SR -ac 1 -c:a libmp3lame -b:a 128k phone-tones.mp3 -hide_banner -loglevel error

cp phone-tones.mp3 /tmp/phone-tones.mp3
echo "rendered $(stat -f%z /tmp/phone-tones.mp3) bytes"

# Upload
set -a; source ~/.claude/cron/.env; set +a
SUPABASE_URL="https://ltaaiiqtrmlqrzhglxob.supabase.co"
SK="$SUPABASE_SERVICE_ROLE_KEY"
curl -sS -X POST "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/show/phone-tones-${RANDOM}.mp3" \
  -H "apikey: $SK" -H "authorization: Bearer $SK" -H "x-upsert: true" -H "content-type: audio/mpeg" \
  --data-binary "@/tmp/phone-tones.mp3"
