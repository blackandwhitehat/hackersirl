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
TGSH="$HOME/.claude/cron/lib/tg.sh"

# Show assets URLs are looked up at run time from hir_show_assets so
# admin can swap intro/outro/bg/phone-tones without redeploying.
fetch_asset() {
  local atype="$1"
  curl -s "${SUPABASE_URL}/rest/v1/hir_show_assets?asset_type=eq.${atype}&active=eq.true&order=created_at.desc&limit=1&select=audio_url" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" | jq -r '.[0].audio_url // empty'
}

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

# Resolve current show assets at run time
INTRO_URL=$(fetch_asset intro)
OUTRO_URL=$(fetch_asset outro)
PHONE_URL=$(fetch_asset phone_tones)
BG_INTRO_URL=$(fetch_asset bg_intro)
BG_OUTRO_URL=$(fetch_asset bg_outro)

# Hash a string with sha256 — used to fingerprint the inputs that
# went into a rendered episode MP3. If the hash matches what's stored
# on the row, the rendered MP3 is up to date; if not, the episode
# needs to be re-rendered. Lets the cron skip unchanged work and
# auto-pick up after any asset/text edit.
#
# RENDER_VERSION is mixed into every hash so changes to the cron's
# mix logic itself (filter graph, fade timing, concat order, etc.)
# invalidate every existing hash and trigger a one-time catalog re-
# render. Bump it whenever the render pipeline changes.
RENDER_VERSION="v3"
sha() { printf '%s' "$1" | shasum -a 256 | awk '{print $1}'; }

# Compose the canonical input string for an episode. Order matters
# (changing the order would invalidate every existing hash).
episode_inputs() {
  local title="$1" desc="$2" src="$3" anon="$4" handle="$5"
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' \
    "$RENDER_VERSION" \
    "${INTRO_URL:-}" "${OUTRO_URL:-}" "${BG_INTRO_URL:-}" "${BG_OUTRO_URL:-}" "${PHONE_URL:-}" \
    "${src:-}" "${handle:-}" "${anon:-false}" "${title:-}" "${desc:-}"
}

# Stale-check pass: walk every live episode, compute its current input
# hash from the active assets + DB metadata, and compare to the hash
# stored at last render. Mismatch = inputs changed since render = flip
# back to pending so the loop below picks it up. Live MP3 stays served
# at its existing audio_url until the new render lands.
echo "scanning for stale renders..."
LIVE=$(curl -s "${SUPABASE_URL}/rest/v1/hir_episodes?processing_state=eq.live&select=id,submission_id,title,description,source_audio_url,input_hash" \
  -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY")
STALE=0
jq -c '.[]' <<<"$LIVE" 2>/dev/null | while read -r erow; do
  EID=$(jq -r .id <<<"$erow")
  STORED=$(jq -r '.input_hash // empty' <<<"$erow")
  ETITLE=$(jq -r '.title // ""' <<<"$erow")
  EDESC=$(jq -r '.description // ""' <<<"$erow")
  ESRC=$(jq -r '.source_audio_url // ""' <<<"$erow")
  ESID=$(jq -r '.submission_id // ""' <<<"$erow")
  [ -z "$ESID" ] && continue
  ESUB=$(curl -s "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${ESID}&select=handle_audio_url,handle_presented_url,handle_intro_url,anon" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" | jq -c '.[0] // {}')
  EANON=$(jq -r '.anon // false' <<<"$ESUB")
  EHANDLE=$(jq -r '.handle_intro_url // ""' <<<"$ESUB")
  [ -z "$EHANDLE" ] && EHANDLE=$(jq -r '.handle_presented_url // ""' <<<"$ESUB")
  [ -z "$EHANDLE" ] && [ "$EANON" != "true" ] && EHANDLE=$(jq -r '.handle_audio_url // ""' <<<"$ESUB")
  CURRENT=$(sha "$(episode_inputs "$ETITLE" "$EDESC" "$ESRC" "$EANON" "$EHANDLE")")
  if [ "$STORED" != "$CURRENT" ]; then
    echo "  stale episode $EID (hash $STORED → $CURRENT)"
    curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_episodes?id=eq.${EID}" \
      -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
      -H "content-type: application/json" -H "prefer: return=minimal" \
      -d '{"processing_state":"pending"}' > /dev/null
  fi
done

# Same hash check for ready-state submission previews. Preview render
# only triggers when preview_audio_url IS NULL, so we null it on stale
# rows to force a re-render. preview_input_hash stored separately.
# Anon submissions have body_audio_url=null (anonymity guard scrubs the
# raw caller voice) but still have body_audio_anon_url, so we accept
# either source.
PREVIEW_LIVE=$(curl -s "${SUPABASE_URL}/rest/v1/hir_submissions?status=eq.ready&preview_audio_url=not.is.null&or=(body_audio_url.not.is.null,body_audio_anon_url.not.is.null)&select=id,handle,handle_audio_url,handle_presented_url,handle_intro_url,body_audio_url,body_audio_anon_url,anon,preview_input_hash" \
  -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY")
jq -c '.[]' <<<"$PREVIEW_LIVE" 2>/dev/null | while read -r prow; do
  PID=$(jq -r .id <<<"$prow")
  PSTORED=$(jq -r '.preview_input_hash // empty' <<<"$prow")
  PHTXT=$(jq -r '.handle // ""' <<<"$prow")
  PANON=$(jq -r '.anon // false' <<<"$prow")
  PBODY_RAW=$(jq -r '.body_audio_url // ""' <<<"$prow")
  PBODY_ANON=$(jq -r '.body_audio_anon_url // ""' <<<"$prow")
  PSRC="$PBODY_RAW"
  [ "$PANON" = "true" ] && [ -n "$PBODY_ANON" ] && PSRC="$PBODY_ANON"
  PHI=$(jq -r '.handle_intro_url // ""' <<<"$prow")
  [ -z "$PHI" ] && PHI=$(jq -r '.handle_presented_url // ""' <<<"$prow")
  [ -z "$PHI" ] && [ "$PANON" != "true" ] && PHI=$(jq -r '.handle_audio_url // ""' <<<"$prow")
  PCURRENT=$(sha "$(episode_inputs "PREVIEW: ${PHTXT:-untitled}" "Preview render — not yet published." "$PSRC" "$PANON" "$PHI")")
  if [ "$PSTORED" != "$PCURRENT" ]; then
    echo "  stale preview $PID (hash $PSTORED → $PCURRENT)"
    curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${PID}" \
      -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
      -H "content-type: application/json" -H "prefer: return=minimal" \
      -d '{"preview_audio_url":null}' > /dev/null
  fi
done

ROWS=$(curl -s "${SUPABASE_URL}/rest/v1/hir_episodes?processing_state=eq.pending&select=id,submission_id,title,description,episode_number,season,guid,source_audio_url&order=created_at.asc&limit=5" \
  -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY")
COUNT=$(jq 'length' <<<"$ROWS" 2>/dev/null) || COUNT=0

# Also pull submissions that don't have a preview rendered yet so admin
# can hear the final mix before clicking Publish.
PREVIEWS=$(curl -s "${SUPABASE_URL}/rest/v1/hir_submissions?status=eq.ready&preview_audio_url=is.null&or=(body_audio_url.not.is.null,body_audio_anon_url.not.is.null)&select=id,handle,handle_audio_url,handle_presented_url,handle_intro_url,body_audio_url,body_audio_anon_url,anon&order=created_at.asc&limit=5" \
  -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY")
PCOUNT=$(jq 'length' <<<"$PREVIEWS" 2>/dev/null) || PCOUNT=0

echo "queue: $COUNT publish · $PCOUNT previews"
[ "$COUNT" = "0" ] && [ "$PCOUNT" = "0" ] && exit 0

INTRO_LOCAL="$WORKDIR/intro.mp3"
OUTRO_LOCAL="$WORKDIR/outro.mp3"
PHONE_LOCAL="$WORKDIR/phone.mp3"
BG_INTRO_LOCAL="$WORKDIR/bg-intro.mp3"
BG_OUTRO_LOCAL="$WORKDIR/bg-outro.mp3"

curl -sLfo "$INTRO_LOCAL"     "$INTRO_URL"
curl -sLfo "$OUTRO_LOCAL"     "$OUTRO_URL"
[ -n "$PHONE_URL"    ] && curl -sLfo "$PHONE_LOCAL"    "$PHONE_URL"    || true
[ -n "$BG_INTRO_URL" ] && curl -sLfo "$BG_INTRO_LOCAL" "$BG_INTRO_URL" || true
[ -n "$BG_OUTRO_URL" ] && curl -sLfo "$BG_OUTRO_LOCAL" "$BG_OUTRO_URL" || true

[ ! -s "$INTRO_LOCAL" ] || [ ! -s "$OUTRO_LOCAL" ] && { echo "intro/outro fetch failed (no active asset?)"; exit 1; }
[ ! -s "$PHONE_LOCAL"    ] && PHONE_LOCAL=""
[ ! -s "$BG_INTRO_LOCAL" ] && BG_INTRO_LOCAL=""
[ ! -s "$BG_OUTRO_LOCAL" ] && BG_OUTRO_LOCAL=""

# ── render_episode WORKID HANDLE_URL BODY_URL ANON OUT_PATH [TITLE DESC EP_NUM SEASON] ──
# Final episode mix:
#   phone_tones (if active) → bg_intro+intro_voice mixed → handle (no bg)
#   → body (no bg) → bg_outro+outro_voice mixed
# Loudness normalized to -16 LUFS (Apple/Spotify spec). MP3 with ID3v2.
#
# With the handle "presenter" pass enabled, the AI presenter voice
# re-speaks the caller's handle so anon submissions can keep one too.
# bg_intro/bg_outro/phone_tones gracefully degrade if unset.
render_episode() {
  local id="$1" handle_url="$2" body_url="$3" anon="$4" out="$5"
  local title="${6:-Hackers IRL}" desc="${7:-}" ep_num="${8:-1}" season="${9:-}"
  local body_in="$WORKDIR/${id}-body.in"
  local body_mp3="$WORKDIR/${id}-body.mp3"

  curl -sLfo "$body_in" "$body_url" || { echo "    body download failed"; return 1; }
  ffmpeg -y -i "$body_in" -vn -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k \
    "$body_mp3" > "$WORKDIR/$id.body.log" 2>&1 || {
      echo "    body normalize failed"; tail -3 "$WORKDIR/$id.body.log"; return 1; }

  # Step 1: pre-mix intro voice + bg_intro. amix without normalize=0
  # divides each input by N so bg ends up another -6dB quieter than
  # the bg volume= setting suggests. We pin normalize=0 and bump bg
  # to 0.35 (≈ -9dB under voice peak) so the music is clearly present
  # under the voiceover instead of perceptually buried.
  local intro_mixed="$WORKDIR/${id}-intro-mixed.mp3"
  if [ -n "$BG_INTRO_LOCAL" ] && [ -s "$BG_INTRO_LOCAL" ]; then
    ffmpeg -y -i "$INTRO_LOCAL" -i "$BG_INTRO_LOCAL" \
      -filter_complex "[1:a]volume=0.35,apad[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=in:st=0:d=0.5[out]" \
      -map "[out]" -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k "$intro_mixed" > "$WORKDIR/$id.intromix.log" 2>&1 || {
        echo "    intro mix failed"; tail -5 "$WORKDIR/$id.intromix.log"; intro_mixed="$INTRO_LOCAL"; }
  else
    intro_mixed="$INTRO_LOCAL"
  fi

  # Step 2: pre-mix outro voice + bg_outro. NO afade here — the
  # previous version had `afade=out:st=0:d=2` which blanked the
  # entire outro after 2s (fade *starts* at second 0, so by second 2
  # the audio is silent forever). The bg track's own fade-out shapes
  # the tail; the voice ends naturally. If we want a final-mix fade
  # we'd add it after loudnorm, not on the outro chunk in isolation.
  local outro_mixed="$WORKDIR/${id}-outro-mixed.mp3"
  if [ -n "$BG_OUTRO_LOCAL" ] && [ -s "$BG_OUTRO_LOCAL" ]; then
    ffmpeg -y -i "$OUTRO_LOCAL" -i "$BG_OUTRO_LOCAL" \
      -filter_complex "[1:a]volume=0.35,apad[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]" \
      -map "[out]" -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k "$outro_mixed" > "$WORKDIR/$id.outromix.log" 2>&1 || {
        echo "    outro mix failed"; tail -5 "$WORKDIR/$id.outromix.log"; outro_mixed="$OUTRO_LOCAL"; }
  else
    outro_mixed="$OUTRO_LOCAL"
  fi

  # Step 3: handle. Prefer the AI-presenter version (handle_presented_url
  # — caller's handle re-spoken by the show's presenter voice). For anon
  # submissions we ONLY use the presented URL; raw handle audio would
  # leak the caller's voice. For non-anon, fall back to the raw handle
  # if the presented version isn't available yet.
  local handle_mp3=""
  if [ -n "$handle_url" ] && [ "$handle_url" != "null" ]; then
    handle_mp3="$WORKDIR/${id}-handle.mp3"
    echo "    handle: download $handle_url"
    if ! curl -sLfo "$WORKDIR/${id}-handle.in" "$handle_url"; then
      echo "    handle: download failed"
      handle_mp3=""
    elif [ ! -s "$WORKDIR/${id}-handle.in" ]; then
      echo "    handle: download empty"
      handle_mp3=""
    elif ! ffmpeg -y -i "$WORKDIR/${id}-handle.in" -vn -ac 1 -ar 44100 -c:a libmp3lame -b:a 128k \
            "$handle_mp3" > "$WORKDIR/$id.handle.log" 2>&1; then
      echo "    handle: ffmpeg failed"
      tail -5 "$WORKDIR/$id.handle.log"
      handle_mp3=""
    elif [ ! -s "$handle_mp3" ]; then
      echo "    handle: encoded file empty"
      handle_mp3=""
    else
      echo "    handle: ready ($(stat -f%z "$handle_mp3") bytes)"
    fi
  else
    echo "    handle: no URL provided"
  fi

  # Step 4: final concat — [phone] [intro_mixed] [handle?] [body] [outro_mixed]
  local inputs=()
  local cat=""
  local n=0
  if [ -n "$PHONE_LOCAL" ] && [ -s "$PHONE_LOCAL" ]; then
    inputs+=(-i "$PHONE_LOCAL"); cat="${cat}[${n}:a]"; n=$((n + 1))
  fi
  inputs+=(-i "$intro_mixed"); cat="${cat}[${n}:a]"; n=$((n + 1))
  if [ -n "$handle_mp3" ]; then
    inputs+=(-i "$handle_mp3"); cat="${cat}[${n}:a]"; n=$((n + 1))
  fi
  inputs+=(-i "$body_mp3");    cat="${cat}[${n}:a]"; n=$((n + 1))
  inputs+=(-i "$outro_mixed"); cat="${cat}[${n}:a]"; n=$((n + 1))

  local concat_filter="${cat}concat=n=${n}:v=0:a=1[c];[c]loudnorm=I=-16:LRA=11:TP=-1.5[out]"
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
      echo "    final mix failed"; tail -10 "$WORKDIR/$id.mix.log"; return 1; }
  return 0
}

# ── publish queue ──
jq -c '.[]' <<<"$ROWS" | while read -r row; do
  ID=$(jq -r .id <<<"$row")
  GUID=$(jq -r .guid <<<"$row")
  TITLE=$(jq -r .title <<<"$row")
  DESC=$(jq -r .description <<<"$row")
  EP_NUM=$(jq -r '.episode_number // ""' <<<"$row")
  SEASON=$(jq -r '.season // ""' <<<"$row")
  SUB_ID=$(jq -r .submission_id <<<"$row")
  SRC=$(jq -r '.source_audio_url // empty' <<<"$row")

  if [ -z "$SRC" ]; then
    echo "  $ID: missing source_audio_url, marking failed"
    curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_episodes?id=eq.${ID}" \
      -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
      -H "content-type: application/json" -H "prefer: return=minimal" \
      -d '{"processing_state":"failed"}' > /dev/null
    continue
  fi

  # Pull submission for handle URL choice + anon flag + show notes.
  # Handle slot priority:
  #   1. handle_intro_url   — host's full intro line ("Up next: X, a Y...")
  #   2. handle_presented_url — host re-speaking just the handle
  #   3. handle_audio_url   — caller's raw recording (NEVER for anon)
  SUB=$(curl -s "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${SUB_ID}&select=handle_audio_url,handle_presented_url,handle_intro_url,anon,show_notes" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" | jq -c '.[0] // {}')
  HANDLE_INTRO=$(jq -r '.handle_intro_url // empty' <<<"$SUB")
  HANDLE_PRESENTED=$(jq -r '.handle_presented_url // empty' <<<"$SUB")
  HANDLE_RAW=$(jq -r '.handle_audio_url // empty' <<<"$SUB")
  ANON=$(jq -r '.anon // false' <<<"$SUB")
  SHOW_NOTES=$(jq -c '.show_notes // {}' <<<"$SUB")
  HANDLE_URL="$HANDLE_INTRO"
  [ -z "$HANDLE_URL" ] && HANDLE_URL="$HANDLE_PRESENTED"
  [ -z "$HANDLE_URL" ] && [ "$ANON" != "true" ] && HANDLE_URL="$HANDLE_RAW"

  # Append show notes to the episode description if any of the lists
  # are non-empty. The cron writes this back to hir_episodes.description
  # so RSS subscribers see shoutouts/links/contact. Non-destructive: if
  # the row already has a manually-curated description we just append.
  NOTES_BLOCK=$(jq -r '
    [
      ((.shoutouts // []) | if length > 0 then "Shoutouts: " + (join(", ")) else empty end),
      ((.urls      // []) | if length > 0 then "Links: "     + (join(" · ")) else empty end),
      ((.emails    // []) | if length > 0 then "Reach: "     + (join(", ")) else empty end)
    ] | map(select(. != null)) | join("\n")
  ' <<<"$SHOW_NOTES")
  if [ -n "$NOTES_BLOCK" ]; then
    DESC="${DESC}

${NOTES_BLOCK}"
  fi

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

  # Compute the input hash for THIS render so the next stale-check
  # pass can compare and skip when nothing's changed.
  HASH=$(sha "$(episode_inputs "$TITLE" "$DESC" "$SRC" "$ANON" "$HANDLE_URL")")

  # Patch the episode row with final audio + flip state. published_at
  # is preserved on re-renders by only setting it on first publish
  # (when the row was previously not 'live').
  PATCH=$(jq -nc --arg u "$PUB_URL" --argjson s "$SIZE" --argjson d "$DUR" --arg h "$HASH" \
    '{audio_url:$u, audio_size_bytes:$s, audio_duration_seconds:$d, audio_mime_type:"audio/mpeg", processing_state:"live", input_hash:$h, published_at:(now|todate)}')
  curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_episodes?id=eq.${ID}" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
    -H "content-type: application/json" -H "prefer: return=minimal" \
    -d "$PATCH" > /dev/null

  # Submission flips to 'published' (idempotent — re-renders no-op this).
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
jq -c '.[]' <<<"$PREVIEWS" | while read -r prow; do
  PID=$(jq -r .id <<<"$prow")
  PHANDLE_INTRO=$(jq -r '.handle_intro_url // empty' <<<"$prow")
  PHANDLE_PRESENTED=$(jq -r '.handle_presented_url // empty' <<<"$prow")
  PHANDLE_RAW=$(jq -r '.handle_audio_url // empty' <<<"$prow")
  PBODY_RAW=$(jq -r '.body_audio_url // empty' <<<"$prow")
  PBODY_ANON=$(jq -r '.body_audio_anon_url // empty' <<<"$prow")
  PANON=$(jq -r '.anon // false' <<<"$prow")
  PHANDLE_TXT=$(jq -r '.handle // ""' <<<"$prow")

  # Handle slot priority same as the publish path: full intro line,
  # then presenter handle, then raw (only for non-anon).
  PHANDLE="$PHANDLE_INTRO"
  [ -z "$PHANDLE" ] && PHANDLE="$PHANDLE_PRESENTED"
  [ -z "$PHANDLE" ] && [ "$PANON" != "true" ] && PHANDLE="$PHANDLE_RAW"

  # Body: anon uses swapped if available; non-anon uses raw.
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
  # Same hash composition the stale-check pass uses, so the next run
  # of this cron correctly detects when a preview is up-to-date.
  PHASH=$(sha "$(episode_inputs "PREVIEW: ${PHANDLE_TXT:-untitled}" "Preview render — not yet published." "$PSRC" "$PANON" "$PHANDLE")")
  PATCH=$(jq -nc --arg u "$PUB" --argjson s "$PSIZE" --argjson d "$PDUR" --arg h "$PHASH" \
    '{preview_audio_url:$u, preview_size_bytes:$s, preview_duration_seconds:$d, preview_input_hash:$h}')
  curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${PID}" \
    -H "apikey: $SUPABASE_KEY" -H "authorization: Bearer $SUPABASE_KEY" \
    -H "content-type: application/json" -H "prefer: return=minimal" \
    -d "$PATCH" > /dev/null
  echo "    preview ready: $PUB ($PSIZE bytes, ${PDUR}s)"
done

echo "=== done ==="
