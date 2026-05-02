#!/usr/bin/env zsh
# hackersirl-process.sh — every 5 min via launchd
# Plist: ~/Library/LaunchAgents/com.quantos.hackersirl-process.plist
#
# Polls hir_submissions for rows whose audio is hosted (status='ready')
# but transcript IS NULL. For each row:
#   1. download body audio (anon URL if anon=true, else raw body)
#   2. run mlx_whisper -> transcript
#   3. invoke claude -p to draft title + description
#   4. PATCH transcript + suggested_title + suggested_description back
#
# Audio rehost + ElevenLabs anon swap stays in CF Pages /api/process —
# those need to happen close to the call. This cron is the "make it
# show up nicely in the admin queue" worker.

set -u
export PATH="$HOME/.local/bin:$HOME/Library/Python/3.9/bin:$HOME/.bun/bin:$HOME/bin/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="${HOME:-/Users/quantos-bot}"

set -a
source "$HOME/.claude/cron/.env"
set +a

SUPABASE_URL="${SUPABASE_URL:-https://ltaaiiqtrmlqrzhglxob.supabase.co}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY must be set}"
MLX_WHISPER="$HOME/Library/Python/3.9/bin/mlx_whisper"
WHISPER_MODEL="${WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}"
LOCK="/tmp/hackersirl-process.lock"
TGSH="$HOME/.claude/cron/lib/tg.sh"

# Single-run guard via mkdir (atomic on POSIX). macOS has no flock.
LOCKDIR="/tmp/hackersirl-process.lock.d"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # Stale lock check — if owner pid is dead, take it.
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
trap 'rm -rf "$LOCKDIR" "$WORKDIR"' EXIT

WORKDIR=$(mktemp -d /tmp/hir-process.XXXXXX)

echo "=== hackersirl-process $(date -u +%FT%TZ) ==="

ROWS=$(curl -s "${SUPABASE_URL}/rest/v1/hir_submissions?status=eq.ready&transcript=is.null&select=id,anon,anon_voice_id,body_audio_url,body_audio_anon_url,handle&order=created_at.asc&limit=10" \
  -H "apikey: ${SUPABASE_KEY}" -H "authorization: Bearer ${SUPABASE_KEY}")

COUNT=$(echo "$ROWS" | jq 'length' 2>/dev/null || echo 0)
echo "queue: $COUNT"
[ "$COUNT" = "0" ] && exit 0

processed=0
echo "$ROWS" | jq -c '.[]' | while read -r row; do
  ID=$(echo "$row" | jq -r .id)
  ANON=$(echo "$row" | jq -r .anon)
  ANON_VOICE=$(echo "$row" | jq -r '.anon_voice_id // "operator"')
  ANON_URL=$(echo "$row" | jq -r '.body_audio_anon_url // empty')
  BODY_URL=$(echo "$row" | jq -r '.body_audio_url // empty')
  HANDLE=$(echo "$row" | jq -r '.handle // ""')

  if [ "$ANON" = "true" ] && [ -n "$ANON_URL" ]; then
    AUDIO_URL="$ANON_URL"
  elif [ -n "$BODY_URL" ]; then
    AUDIO_URL="$BODY_URL"
  else
    echo "  $ID: no audio url, skipping"
    continue
  fi

  MP3="$WORKDIR/$ID.mp3"
  echo "  $ID: download $AUDIO_URL"
  if ! curl -sLfo "$MP3" "$AUDIO_URL" || [ ! -s "$MP3" ]; then
    echo "  $ID: download failed"
    continue
  fi

  echo "  $ID: transcribe ($(stat -f%z "$MP3" 2>/dev/null) bytes)"
  if ! "$MLX_WHISPER" "$MP3" \
      --model "$WHISPER_MODEL" \
      --output-dir "$WORKDIR" \
      --output-name "$ID" \
      --output-format txt \
      --language en \
      --verbose False > "$WORKDIR/$ID.whisper.log" 2>&1; then
    echo "  $ID: whisper failed (see $WORKDIR/$ID.whisper.log)"
    tail -5 "$WORKDIR/$ID.whisper.log"
    continue
  fi

  TXT="$WORKDIR/$ID.txt"
  if [ ! -s "$TXT" ]; then
    echo "  $ID: empty transcript, skipping"
    continue
  fi

  TRANSCRIPT_PREVIEW=$(head -c 120 "$TXT")
  echo "  $ID: transcript: $TRANSCRIPT_PREVIEW..."

  # Single Claude pass that pulls everything we need from the transcript:
  # title, description, presenter intro line (so the show host can
  # introduce the caller by handle + how they described themselves),
  # and structured show notes (shoutouts, urls, emails).
  #
  # The intro_line specifically goes into the final mix as TTS in the
  # presenter voice, slotted between the show intro and the caller's
  # body audio. Without it the listener jumps straight from "this show
  # is voicemails" into someone's voice with no context.
  PROMPT=$(cat <<EOF
You're a producer for "Hackers IRL", a podcast of short voicemails from people in the hacking and infosec community talking about their day. Tone: human, warm, curious, never breathless or marketing-y. No em-dashes anywhere.

Listen to this submission and produce a JSON object. Reply with ONLY the JSON, nothing else.

{
  "title":         "under 70 chars, captures the heart of the story",
  "description":   "one short paragraph under 240 chars, what this episode is about",
  "intro_line":    "the show host introducing this caller right after the intro music. Format roughly: 'Up next: <handle>, <how they described themselves in the transcript>. Here's their story.' If the caller didn't describe themselves, just 'Up next: <handle>. Here's their story.' If no handle either, 'Up next, an anonymous caller. Here's their story.' One natural sentence, max ~30 words. The host says this — write it for the host's voice.",
  "shoutouts":     ["names or handles of people the caller mentioned, credited, or thanked"],
  "urls":          ["any URL the caller mentioned (full URL with scheme if given)"],
  "emails":        ["any email address the caller mentioned"]
}

Empty arrays are fine if nothing applies. Don't invent shoutouts/urls/emails — only include what's actually in the transcript.

Caller handle: ${HANDLE:-(none provided)}
Transcript:
$(head -c 6000 "$TXT")
EOF
)

  DRAFT_RAW=$(echo "$PROMPT" | claude -p --output-format json --max-turns 1 2>/dev/null || true)
  DRAFT_TEXT=$(echo "$DRAFT_RAW" | jq -r '.result // empty' 2>/dev/null)
  # Claude sometimes wraps in code fences — pull the JSON object out.
  DRAFT_JSON=$(echo "$DRAFT_TEXT" | sed -n '/{/,/}$/p' | tr -d '\n')
  TITLE=$(echo "$DRAFT_JSON"      | jq -r '.title // empty'        2>/dev/null)
  DESC=$(echo  "$DRAFT_JSON"      | jq -r '.description // empty'  2>/dev/null)
  INTRO_LINE=$(echo "$DRAFT_JSON" | jq -r '.intro_line // empty'   2>/dev/null)
  NOTES_JSON=$(echo "$DRAFT_JSON" | jq -c '{shoutouts:(.shoutouts//[]), urls:(.urls//[]), emails:(.emails//[])}' 2>/dev/null || echo '{}')
  echo "  $ID: draft title=\"$TITLE\""
  echo "  $ID: intro_line=\"$INTRO_LINE\""
  echo "  $ID: show_notes=$NOTES_JSON"

  # Render the presenter intro line via ElevenLabs TTS (presenter
  # voice — falls back to anchor). This becomes handle_intro_url and
  # the publish cron uses it in place of the raw handle audio so the
  # host always introduces each caller cleanly.
  HANDLE_INTRO_URL=""
  if [ -n "$INTRO_LINE" ] && [ -n "${ELEVENLABS_API_KEY:-}" ]; then
    PVID="${ELEVENLABS_VOICE_PRESENTER:-${ELEVENLABS_VOICE_ANCHOR:-bAq8AI9QURijOtmeFFqT}}"
    INTRO_OUT="$WORKDIR/$ID-intro.mp3"
    if curl -sS -X POST "https://api.elevenlabs.io/v1/text-to-speech/${PVID}?output_format=mp3_44100_128" \
        -H "xi-api-key: $ELEVENLABS_API_KEY" \
        -H "content-type: application/json" \
        -d "$(jq -nc --arg t "$INTRO_LINE" '{text:$t, model_id:"eleven_turbo_v2_5", voice_settings:{stability:0.55, similarity_boost:0.85, style:0.30, use_speaker_boost:true}}')" \
        -o "$INTRO_OUT" --max-time 60 \
       && [ -s "$INTRO_OUT" ] && [ "$(stat -f%z "$INTRO_OUT")" -gt 2000 ]; then
      UPHTTP=$(curl -s -o /tmp/hir-intro-resp -w "%{http_code}" -X POST \
        "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/handle-intro/${ID}.mp3" \
        -H "apikey: ${SUPABASE_KEY}" -H "authorization: Bearer ${SUPABASE_KEY}" \
        -H "x-upsert: true" -H "content-type: audio/mpeg" \
        --data-binary "@$INTRO_OUT")
      if [ "$UPHTTP" = "200" ] || [ "$UPHTTP" = "201" ]; then
        HANDLE_INTRO_URL="${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/handle-intro/${ID}.mp3"
        echo "  $ID: handle intro uploaded ($(stat -f%z "$INTRO_OUT") bytes)"
      else
        echo "  $ID: handle intro upload failed HTTP $UPHTTP"
      fi
    else
      echo "  $ID: handle intro TTS skipped"
    fi
  fi

  # PATCH the row with all the derived fields. Don't touch
  # body_audio_anon_url here — the CF function's S2S swap is canonical.
  PAYLOAD=$(jq -nc \
    --rawfile t "$TXT" \
    --arg ti "$TITLE" \
    --arg de "$DESC" \
    --arg hi "$HANDLE_INTRO_URL" \
    --argjson sn "$NOTES_JSON" \
    'if $hi == "" then {transcript:$t, suggested_title:$ti, suggested_description:$de, show_notes:$sn}
     else {transcript:$t, suggested_title:$ti, suggested_description:$de, show_notes:$sn, handle_intro_url:$hi}
     end')

  HTTP=$(curl -s -o /tmp/hir-patch-resp -w "%{http_code}" -X PATCH \
    "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${ID}" \
    -H "apikey: ${SUPABASE_KEY}" -H "authorization: Bearer ${SUPABASE_KEY}" \
    -H "content-type: application/json" -H "prefer: return=minimal" \
    -d "$PAYLOAD")
  if [ "$HTTP" = "204" ]; then
    echo "  $ID: ok"
    processed=$((processed + 1))
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -x "$TGSH" ]; then
      "$TGSH" "📞 hackersirl draft ready: $TITLE${HANDLE:+ (@$HANDLE)}" || true
    fi
  else
    echo "  $ID: patch HTTP $HTTP $(cat /tmp/hir-patch-resp 2>/dev/null | head -c 200)"
  fi
done

echo "=== done ($processed processed) ==="
