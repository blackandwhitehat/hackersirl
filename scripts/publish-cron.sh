#!/usr/bin/env zsh
# hackersirl-publish.sh — every 2 min via launchd
# Plist: ~/Library/LaunchAgents/com.quantos.hackersirl-publish.plist
#
# Polls hir_episodes for processing_state='pending', runs ffmpeg to
# concat intro + body + outro, normalize loudness to podcast standard
# (-16 LUFS), encode to MP3, ID3-tag, upload to hackersirl-audio/
# episodes/, and flip processing_state='live'. The final MP3 is what
# /feed.xml publishes — Apple/Spotify get a real, valid file.

set -u
export PATH="$HOME/.local/bin:$HOME/Library/Python/3.9/bin:$HOME/.bun/bin:$HOME/bin/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="${HOME:-/Users/quantos-bot}"

set -a; source "$HOME/.claude/cron/.env"; set +a

SUPABASE_URL="${SUPABASE_URL:-https://ltaaiiqtrmlqrzhglxob.supabase.co}"
SUPABASE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
INTRO_URL="${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/show/intro.mp3"
OUTRO_URL="${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/show/outro.mp3"
TGSH="$HOME/.claude/cron/lib/tg.sh"

# Single-run guard
LOCKDIR="/tmp/hackersirl-publish.lock.d"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  OWNER_PID=$(cat "$LOCKDIR/pid" 2>/dev/null || echo "")
  if [ -n "$OWNER_PID" ] && ! kill -0 "$OWNER_PID" 2>/dev/null; then
    rm -rf "$LOCKDIR"
    mkdir "$LOCKDIR" 2>/dev/null || { echo "lock contention"; exit 0; }
  else
    echo "$(date -u +%FT%TZ) skip: previous run still active (pid=$OWNER_PID)"
    exit 0
  fi
fi
echo $$ > "$LOCKDIR/pid"

WORKDIR=$(mktemp -d /tmp/hir-publish.XXXXXX)
trap 'rm -rf "$LOCKDIR" "$WORKDIR"' EXIT

echo "=== hackersirl-publish $(date -u +%FT%TZ) ==="

ROWS=$(curl -s "${SUPABASE_URL}/rest/v1/hir_episodes?processing_state=eq.pending&select=id,submission_id,title,description,episode_number,season,guid,source_audio_url&order=created_at.asc&limit=5" \
  -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY")

COUNT=$(echo "$ROWS" | jq 'length' 2>/dev/null || echo 0)
echo "queue: $COUNT"
[ "$COUNT" = "0" ] && exit 0

# Cache intro/outro per run (skip the redownload on subsequent rows in same run)
INTRO_LOCAL="$WORKDIR/intro.mp3"
OUTRO_LOCAL="$WORKDIR/outro.mp3"
curl -sLfo "$INTRO_LOCAL" "$INTRO_URL"
curl -sLfo "$OUTRO_LOCAL" "$OUTRO_URL"
[ ! -s "$INTRO_LOCAL" ] || [ ! -s "$OUTRO_LOCAL" ] && { echo "intro/outro fetch failed"; exit 1; }

echo "$ROWS" | jq -c '.[]' | while read -r row; do
  ID=$(echo "$row" | jq -r .id)
  GUID=$(echo "$row" | jq -r .guid)
  TITLE=$(echo "$row" | jq -r .title)
  DESC=$(echo "$row" | jq -r .description)
  EP_NUM=$(echo "$row" | jq -r '.episode_number // ""')
  SEASON=$(echo "$row" | jq -r '.season // ""')
  SUB_ID=$(echo "$row" | jq -r .submission_id)
  SRC=$(echo "$row" | jq -r '.source_audio_url // empty')

  if [ -z "$SRC" ]; then
    echo "  $ID: missing source_audio_url, marking failed"
    curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_episodes?id=eq.${ID}" \
      -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
      -H "content-type: application/json" -H "prefer: return=minimal" \
      -d '{"processing_state":"failed"}' > /dev/null
    continue
  fi

  echo "  $ID: \"$TITLE\""
  BODY="$WORKDIR/${ID}-body"
  if ! curl -sLfo "$BODY.in" "$SRC"; then
    echo "  $ID: source download failed"
    continue
  fi

  # Normalize body to mp3 (mono 44.1k 128k) FIRST so concat doesn't
  # have to deal with codec mismatches between webm/opus body and mp3
  # intro/outro.
  BODY_MP3="$WORKDIR/${ID}-body.mp3"
  if ! ffmpeg -y -i "$BODY.in" -vn -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k "$BODY_MP3" > "$WORKDIR/$ID.ffin.log" 2>&1; then
    echo "  $ID: body normalize failed"
    tail -5 "$WORKDIR/$ID.ffin.log"
    continue
  fi

  # Concat intro + body + outro, loudnorm to -16 LUFS (Apple/Spotify
  # podcast standard), encode to MP3 with ID3 tags.
  FINAL="$WORKDIR/${ID}-final.mp3"
  ALBUM="Hackers IRL${SEASON:+ — Season $SEASON}"
  TRACK="${EP_NUM:-1}"
  if ! ffmpeg -y \
      -i "$INTRO_LOCAL" -i "$BODY_MP3" -i "$OUTRO_LOCAL" \
      -filter_complex "[0:a][1:a][2:a]concat=n=3:v=0:a=1[c];[c]loudnorm=I=-16:LRA=11:TP=-1.5[out]" \
      -map "[out]" -ar 44100 -ac 1 -c:a libmp3lame -b:a 128k \
      -id3v2_version 3 \
      -metadata title="$TITLE" \
      -metadata artist="Hackers IRL" \
      -metadata album_artist="Hackers IRL" \
      -metadata album="$ALBUM" \
      -metadata track="$TRACK" \
      -metadata genre="Podcast" \
      -metadata comment="$DESC" \
      "$FINAL" > "$WORKDIR/$ID.ffmix.log" 2>&1; then
    echo "  $ID: concat/loudnorm failed"
    tail -10 "$WORKDIR/$ID.ffmix.log"
    continue
  fi

  SIZE=$(stat -f%z "$FINAL" 2>/dev/null)
  # ffprobe ships with ffmpeg but the static binary we've got is ffmpeg-only.
  # Pull duration from ffmpeg's own stderr by re-decoding to /dev/null.
  DUR=$(ffmpeg -i "$FINAL" 2>&1 | sed -n 's/.*Duration: \([0-9:.]*\).*/\1/p' | awk -F'[:.]' '{print int($1*3600+$2*60+$3)}')
  [ -z "$DUR" ] && DUR=0
  echo "  $ID: rendered $SIZE bytes / ${DUR}s"

  # Upload to canonical episodes/ path keyed by guid (matches the
  # podcast feed's permanent identifier)
  EP_KEY="episodes/${GUID}.mp3"
  HTTP=$(curl -s -o /tmp/hir-up.resp -w "%{http_code}" -X POST \
    "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/${EP_KEY}" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
    -H "x-upsert: true" -H "content-type: audio/mpeg" \
    --data-binary "@$FINAL")
  if [ "$HTTP" != "200" ] && [ "$HTTP" != "201" ]; then
    echo "  $ID: upload failed HTTP $HTTP $(cat /tmp/hir-up.resp | head -c 200)"
    continue
  fi
  PUB_URL="${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/${EP_KEY}"

  # Patch the episode row with final audio + flip state
  PATCH=$(jq -nc --arg u "$PUB_URL" --argjson s "$SIZE" --argjson d "$DUR" \
    '{audio_url:$u, audio_size_bytes:$s, audio_duration_seconds:$d, audio_mime_type:"audio/mpeg", processing_state:"live", published_at:(now|todate)}')
  curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_episodes?id=eq.${ID}" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
    -H "content-type: application/json" -H "prefer: return=minimal" \
    -d "$PATCH" > /dev/null

  # Submission flips to 'published'
  curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${SUB_ID}" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
    -H "content-type: application/json" -H "prefer: return=minimal" \
    -d '{"status":"published"}' > /dev/null

  echo "  $ID: published → $PUB_URL"

  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -x "$TGSH" ]; then
    "$TGSH" "🎙️ hackersirl episode live: $TITLE" || true
  fi
done

echo "=== done ==="
