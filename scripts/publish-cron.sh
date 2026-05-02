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

# Also pull submissions that don't have a preview rendered yet so admin
# can hear the final mix before clicking Publish.
PREVIEWS=$(curl -s "${SUPABASE_URL}/rest/v1/hir_submissions?status=eq.ready&preview_audio_url=is.null&body_audio_url=not.is.null&select=id,handle,handle_audio_url,body_audio_url,body_audio_anon_url,anon&order=created_at.asc&limit=5" \
  -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY")
PCOUNT=$(echo "$PREVIEWS" | jq 'length' 2>/dev/null || echo 0)

echo "queue: $COUNT publish · $PCOUNT previews"
[ "$COUNT" = "0" ] && [ "$PCOUNT" = "0" ] && exit 0

# Cache intro/outro per run (skip the redownload on subsequent rows in same run)
INTRO_LOCAL="$WORKDIR/intro.mp3"
OUTRO_LOCAL="$WORKDIR/outro.mp3"
curl -sLfo "$INTRO_LOCAL" "$INTRO_URL"
curl -sLfo "$OUTRO_LOCAL" "$OUTRO_URL"
[ ! -s "$INTRO_LOCAL" ] || [ ! -s "$OUTRO_LOCAL" ] && { echo "intro/outro fetch failed"; exit 1; }

# ── render_episode WORKID HANDLE_URL BODY_URL ANON OUT_PATH [TITLE DESC EP_NUM SEASON] ──
# Renders the standard HackersIRL mix. Concats intro + handle + body +
# outro for non-anon. For anon, the handle is dropped (it isn't run
# through ElevenLabs S2S, so including it would unmask the caller).
# Returns 0 on success, non-zero on failure.
render_episode() {
  local id="$1" handle_url="$2" body_url="$3" anon="$4" out="$5"
  local title="${6:-Hackers IRL}" desc="${7:-}" ep_num="${8:-1}" season="${9:-}"
  local body_in="$WORKDIR/${id}-body.in"
  local body_mp3="$WORKDIR/${id}-body.mp3"
  local handle_mp3=""

  curl -sLfo "$body_in" "$body_url" || { echo "    body download failed"; return 1; }
  ffmpeg -y -i "$body_in" -vn -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k \
    "$body_mp3" > "$WORKDIR/$id.body.log" 2>&1 || {
      echo "    body normalize failed"; tail -3 "$WORKDIR/$id.body.log"; return 1; }

  local inputs=(-i "$INTRO_LOCAL")
  local concat_filter="[0:a]"
  local n=1
  if [ "$anon" != "true" ] && [ -n "$handle_url" ] && [ "$handle_url" != "null" ]; then
    handle_mp3="$WORKDIR/${id}-handle.mp3"
    if curl -sLfo "$WORKDIR/${id}-handle.in" "$handle_url" \
       && ffmpeg -y -i "$WORKDIR/${id}-handle.in" -vn -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k \
            "$handle_mp3" > "$WORKDIR/$id.handle.log" 2>&1; then
      inputs+=(-i "$handle_mp3")
      concat_filter="${concat_filter}[${n}:a]"; n=$((n + 1))
    fi
  fi
  inputs+=(-i "$body_mp3"); concat_filter="${concat_filter}[${n}:a]"; n=$((n + 1))
  inputs+=(-i "$OUTRO_LOCAL"); concat_filter="${concat_filter}[${n}:a]"; n=$((n + 1))
  concat_filter="${concat_filter}concat=n=${n}:v=0:a=1[c];[c]loudnorm=I=-16:LRA=11:TP=-1.5[out]"

  local album="Hackers IRL${season:+ — Season $season}"
  ffmpeg -y "${inputs[@]}" \
    -filter_complex "$concat_filter" \
    -map "[out]" -ar 44100 -ac 1 -c:a libmp3lame -b:a 128k \
    -id3v2_version 3 \
    -metadata title="$title" \
    -metadata artist="Hackers IRL" \
    -metadata album_artist="Hackers IRL" \
    -metadata album="$album" \
    -metadata track="$ep_num" \
    -metadata genre="Podcast" \
    -metadata comment="$desc" \
    "$out" > "$WORKDIR/$id.mix.log" 2>&1 || {
      echo "    concat/loudnorm failed"; tail -8 "$WORKDIR/$id.mix.log"; return 1; }
  return 0
}

# ── publish queue ──
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

  # Pull submission to get handle URL + anon flag (source_audio_url
  # already accounts for anon/non-anon body choice).
  SUB=$(curl -s "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${SUB_ID}&select=handle_audio_url,anon" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" | jq -c '.[0] // {}')
  HANDLE_URL=$(echo "$SUB" | jq -r '.handle_audio_url // empty')
  ANON=$(echo "$SUB" | jq -r '.anon // false')

  echo "  $ID: \"$TITLE\""
  FINAL="$WORKDIR/${ID}-final.mp3"
  if ! render_episode "$ID" "$HANDLE_URL" "$SRC" "$ANON" "$FINAL" "$TITLE" "$DESC" "$EP_NUM" "$SEASON"; then
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

# ── preview queue (status='ready' rows that don't have a final-mix
# preview yet — admin uses this to listen to / download what the
# published episode will sound like before clicking Publish) ──
echo "$PREVIEWS" | jq -c '.[]' | while read -r prow; do
  PID=$(echo "$prow" | jq -r .id)
  PHANDLE=$(echo "$prow" | jq -r '.handle_audio_url // empty')
  PBODY_RAW=$(echo "$prow" | jq -r '.body_audio_url // empty')
  PBODY_ANON=$(echo "$prow" | jq -r '.body_audio_anon_url // empty')
  PANON=$(echo "$prow" | jq -r '.anon // false')
  PHANDLE_TXT=$(echo "$prow" | jq -r '.handle // ""')

  # Anon path uses the swapped body if rendered; otherwise fall back to
  # the raw body so we still have something for admin to preview.
  PSRC="$PBODY_RAW"
  [ "$PANON" = "true" ] && [ -n "$PBODY_ANON" ] && PSRC="$PBODY_ANON"
  [ -z "$PSRC" ] && continue

  echo "  preview $PID${PHANDLE_TXT:+ (@$PHANDLE_TXT)}"
  PFINAL="$WORKDIR/${PID}-preview.mp3"
  if ! render_episode "$PID" "$PHANDLE" "$PSRC" "$PANON" "$PFINAL" \
         "PREVIEW: ${PHANDLE_TXT:-untitled}" "Preview render — not yet published." "0" ""; then
    continue
  fi

  PSIZE=$(stat -f%z "$PFINAL" 2>/dev/null)
  PDUR=$(ffmpeg -i "$PFINAL" 2>&1 | sed -n 's/.*Duration: \([0-9:.]*\).*/\1/p' | awk -F'[:.]' '{print int($1*3600+$2*60+$3)}')
  [ -z "$PDUR" ] && PDUR=0

  PKEY="previews/${PID}.mp3"
  HTTP=$(curl -s -o /tmp/hir-up.resp -w "%{http_code}" -X POST \
    "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/${PKEY}" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
    -H "x-upsert: true" -H "content-type: audio/mpeg" \
    --data-binary "@$PFINAL")
  if [ "$HTTP" != "200" ] && [ "$HTTP" != "201" ]; then
    echo "    preview upload failed HTTP $HTTP"; continue
  fi
  PUB="${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/${PKEY}"
  PATCH=$(jq -nc --arg u "$PUB" --argjson s "$PSIZE" --argjson d "$PDUR" \
    '{preview_audio_url:$u, preview_size_bytes:$s, preview_duration_seconds:$d}')
  curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${PID}" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
    -H "content-type: application/json" -H "prefer: return=minimal" \
    -d "$PATCH" > /dev/null
  echo "    preview ready: $PUB ($PSIZE bytes, ${PDUR}s)"
done

echo "=== done ==="
