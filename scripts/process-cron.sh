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

# Pick up any submission that's missing transcript OR the newer
# derived fields (handle_intro_url, show_notes). Rows that already
# have a transcript skip the mlx_whisper step but still get the
# Claude pass + presenter-intro TTS.
ROWS=$(curl -s "${SUPABASE_URL}/rest/v1/hir_submissions?status=in.(ready,published)&or=(transcript.is.null,handle_intro_url.is.null,show_notes.is.null)&select=id,anon,anon_voice_id,body_audio_url,body_audio_anon_url,handle,transcript&order=created_at.asc&limit=10" \
  -H "apikey: ${SUPABASE_KEY}" -H "authorization: Bearer ${SUPABASE_KEY}")

COUNT=$(jq 'length' <<<"$ROWS" 2>/dev/null) || COUNT=0
echo "queue: $COUNT"
[ "$COUNT" = "0" ] && exit 0

processed=0
jq -c '.[]' <<<"$ROWS" | while read -r row; do
  ID=$(jq -r .id <<<"$row")
  ANON=$(jq -r .anon <<<"$row")
  ANON_VOICE=$(jq -r '.anon_voice_id // "operator"' <<<"$row")
  ANON_URL=$(jq -r '.body_audio_anon_url // empty' <<<"$row")
  BODY_URL=$(jq -r '.body_audio_url // empty' <<<"$row")
  HANDLE=$(jq -r '.handle // ""' <<<"$row")
  EXISTING_TRANSCRIPT=$(jq -r '.transcript // empty' <<<"$row")

  TXT="$WORKDIR/$ID.txt"

  if [ -n "$EXISTING_TRANSCRIPT" ]; then
    # Row already has transcript — skip the expensive whisper step,
    # just write it to a temp file so the Claude pass below has it.
    printf '%s' "$EXISTING_TRANSCRIPT" > "$TXT"
    echo "  $ID: reusing existing transcript ($(stat -f%z "$TXT") bytes)"
  else
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

    if [ ! -s "$TXT" ]; then
      echo "  $ID: empty transcript, skipping"
      continue
    fi
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
  "intro_line":    "the show host introducing this caller right after the intro music. Be specific and contextual based on what's in the transcript. Examples:\n  - With handle + self-description: 'Up next: Sparky, a SOC analyst at a mid-size bank. Here's their story.'\n  - With handle, no self-description: 'Up next: Sparky, calling in on the way to a celebration of life. Here's their story.' (use whatever they're DOING or the topic of their call as the descriptor)\n  - No handle but transcript has context: 'Up next, a caller running the network village at a hacker con. Here's their story.'\n  - No handle and transcript is too thin to describe: 'Up next, an unnamed caller. Here's their story.'\n  Never say 'anonymous' — say 'unnamed' if you must. One natural sentence, max ~30 words. The host says this — write it for the host's voice.",
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

  DRAFT_RAW=$(claude -p --output-format json --max-turns 1 <<<"$PROMPT" 2>/dev/null || true)
  DRAFT_TEXT=$(jq -r '.result // empty' <<<"$DRAFT_RAW" 2>/dev/null)
  # Claude sometimes wraps in code fences — pull the JSON object out.
  DRAFT_JSON=$(printf '%s' "$DRAFT_TEXT" | sed -n '/{/,/}$/p' | tr -d '\n')
  TITLE=$(jq -r '.title // empty'                                       <<<"$DRAFT_JSON" 2>/dev/null)
  DESC=$(jq -r '.description // empty'                                  <<<"$DRAFT_JSON" 2>/dev/null)
  INTRO_LINE=$(jq -r '.intro_line // empty'                             <<<"$DRAFT_JSON" 2>/dev/null)
  NOTES_JSON=$(jq -c '{shoutouts:(.shoutouts//[]), urls:(.urls//[]), emails:(.emails//[])}' <<<"$DRAFT_JSON" 2>/dev/null || printf '%s' '{}')
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
  # Clear preview_input_hash so the next publish-cron tick treats this
  # submission's preview as stale (the URL stays the same on TTS regen,
  # so the URL-based hash won't catch a content change otherwise).
  PAYLOAD=$(jq -nc \
    --rawfile t "$TXT" \
    --arg ti "$TITLE" \
    --arg de "$DESC" \
    --arg hi "$HANDLE_INTRO_URL" \
    --argjson sn "$NOTES_JSON" \
    'if $hi == "" then {transcript:$t, suggested_title:$ti, suggested_description:$de, show_notes:$sn, preview_input_hash:null}
     else {transcript:$t, suggested_title:$ti, suggested_description:$de, show_notes:$sn, handle_intro_url:$hi, preview_input_hash:null}
     end')

  HTTP=$(curl -s -o /tmp/hir-patch-resp -w "%{http_code}" -X PATCH \
    "${SUPABASE_URL}/rest/v1/hir_submissions?id=eq.${ID}" \
    -H "apikey: ${SUPABASE_KEY}" -H "authorization: Bearer ${SUPABASE_KEY}" \
    -H "content-type: application/json" -H "prefer: return=minimal" \
    -d "$PAYLOAD")
  if [ "$HTTP" = "204" ]; then
    echo "  $ID: ok"
    # If a handle_intro changed and there's a published episode for this
    # submission, clear its input_hash so the publish cron re-renders
    # the live MP3 with the updated host intro.
    if [ -n "$HANDLE_INTRO_URL" ]; then
      curl -s -X PATCH "${SUPABASE_URL}/rest/v1/hir_episodes?submission_id=eq.${ID}" \
        -H "apikey: ${SUPABASE_KEY}" -H "authorization: Bearer ${SUPABASE_KEY}" \
        -H "content-type: application/json" -H "prefer: return=minimal" \
        -d '{"input_hash":null}' > /dev/null
    fi
    processed=$((processed + 1))
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -x "$TGSH" ]; then
      "$TGSH" "📞 hackersirl draft ready: $TITLE${HANDLE:+ (@$HANDLE)}" || true
    fi
  else
    echo "  $ID: patch HTTP $HTTP $(cat /tmp/hir-patch-resp 2>/dev/null | head -c 200)"
  fi
done

echo "=== done ($processed processed) ==="
