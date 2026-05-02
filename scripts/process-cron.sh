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

  # Draft title + description via claude -p (no tools needed).
  PROMPT=$(cat <<EOF
You write podcast episode titles and descriptions for "Hackers IRL", a show of casual voicemails from people in the hacking and infosec community talking about their day. Tone: human, warm, curious, never breathless or marketing-y. No em-dashes. Title under 70 characters. Description one paragraph, under 240 characters.

Reply with ONLY a JSON object, nothing else: {"title":"...","description":"..."}

Caller handle: ${HANDLE}
Transcript:
$(head -c 6000 "$TXT")
EOF
)

  DRAFT_RAW=$(echo "$PROMPT" | claude -p --output-format json --max-turns 1 2>/dev/null || true)
  DRAFT_TEXT=$(echo "$DRAFT_RAW" | jq -r '.result // empty' 2>/dev/null)
  # Pull JSON object out of the response (claude sometimes wraps in code fences).
  DRAFT_JSON=$(echo "$DRAFT_TEXT" | sed -n '/{/,/}/p' | tr -d '\n')
  TITLE=$(echo "$DRAFT_JSON" | jq -r '.title // empty' 2>/dev/null)
  DESC=$(echo "$DRAFT_JSON" | jq -r '.description // empty' 2>/dev/null)
  echo "  $ID: draft title=\"$TITLE\""

  # Anon path: re-render the body via TTS reading the transcript in
  # the chosen target voice. Replaces body_audio_anon_url with a
  # 100% voice-replaced version (zero source-caller traces — S2S
  # preserves prosody, TTS does not). Live S2S preview during the
  # call is still kept as a quick preview; this overwrites with the
  # final version that's published.
  ANON_TTS_URL=""
  if [ "$ANON" = "true" ] && [ -n "${ELEVENLABS_API_KEY:-}" ]; then
    case "$ANON_VOICE" in
      operator) EL_VID="${ELEVENLABS_VOICE_OPERATOR:-nPczCjzI2devNBz1zQrb}" ;;
      trucker)  EL_VID="${ELEVENLABS_VOICE_TRUCKER:-N2lVS1w4EtoT3dr4eOWO}" ;;
      anchor)   EL_VID="${ELEVENLABS_VOICE_ANCHOR:-onwK4e9ZLuTAKqWW03F9}" ;;
      *)        EL_VID="${ELEVENLABS_VOICE_OPERATOR:-nPczCjzI2devNBz1zQrb}" ;;
    esac
    TTS_OUT="$WORKDIR/$ID-tts.mp3"
    # Trim transcript to ~5000 chars to stay under EL TTS limits.
    TRANSCRIPT_HEAD=$(head -c 5000 "$TXT")
    echo "  $ID: TTS-of-transcript via $ANON_VOICE ($EL_VID)"
    if curl -sS -X POST "https://api.elevenlabs.io/v1/text-to-speech/${EL_VID}?output_format=mp3_44100_128" \
        -H "xi-api-key: $ELEVENLABS_API_KEY" \
        -H "content-type: application/json" \
        -d "$(jq -nc --arg t "$TRANSCRIPT_HEAD" '{text:$t, model_id:"eleven_turbo_v2_5", voice_settings:{stability:0.55, similarity_boost:0.85, style:0.20, use_speaker_boost:true}}')" \
        -o "$TTS_OUT" \
        --max-time 180; then
      if [ -s "$TTS_OUT" ] && [ "$(stat -f%z "$TTS_OUT")" -gt 5000 ]; then
        # Upload as the new body_audio_anon_url (overwrites previous S2S)
        UPHTTP=$(curl -s -o /tmp/hir-tts-resp -w "%{http_code}" -X POST \
          "${SUPABASE_URL}/storage/v1/object/hackersirl-audio/anon/${ID}.mp3" \
          -H "apikey: ${SUPABASE_KEY}" -H "authorization: Bearer ${SUPABASE_KEY}" \
          -H "x-upsert: true" -H "content-type: audio/mpeg" \
          --data-binary "@$TTS_OUT")
        if [ "$UPHTTP" = "200" ] || [ "$UPHTTP" = "201" ]; then
          ANON_TTS_URL="${SUPABASE_URL}/storage/v1/object/public/hackersirl-audio/anon/${ID}.mp3"
          echo "  $ID: TTS uploaded ($(stat -f%z "$TTS_OUT") bytes)"
        else
          echo "  $ID: TTS upload failed HTTP $UPHTTP"
        fi
      else
        echo "  $ID: TTS output too small, skipping"
      fi
    else
      echo "  $ID: TTS call failed"
    fi
  fi

  PAYLOAD=$(jq -nc \
    --rawfile t "$TXT" \
    --arg ti "$TITLE" \
    --arg de "$DESC" \
    --arg au "$ANON_TTS_URL" \
    'if $au == "" then {transcript:$t, suggested_title:$ti, suggested_description:$de}
     else {transcript:$t, suggested_title:$ti, suggested_description:$de, body_audio_anon_url:$au}
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
