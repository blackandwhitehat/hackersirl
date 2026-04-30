# HackersIRL backend setup

The Pages Functions in `functions/` implement the phone-line operator-log
pipeline + admin queue + RSS feed. Auto-deploys on push to `main`.

## Environment variables (CF Pages → Settings → Environment variables)

Add these as **Production** env vars on the `hackersirl` Pages project. All
are secrets except where noted.

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://ltaaiiqtrmlqrzhglxob.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service-role key from Supabase dashboard |
| `TWILIO_ACCOUNT_SID` | starts with `AC…` |
| `TWILIO_AUTH_TOKEN` | from Twilio console |
| `ELEVENLABS_API_KEY` | from ElevenLabs profile |
| `ELEVENLABS_VOICE_OPERATOR` | voice ID for anon "operator" persona |
| `ELEVENLABS_VOICE_TRUCKER` | voice ID for anon "trucker" persona |
| `ELEVENLABS_VOICE_ANCHOR` | voice ID for anon "news anchor" persona |
| `INTERNAL_SECRET` | random 32-char hex; protects `/api/process` |
| `ADMIN_EMAIL` | the email Cloudflare Access uses to authorize `/admin` |
| `ADMIN_BEARER` | optional fallback bearer token for local testing |
| `PODCAST_OWNER_EMAIL` | email shown in the RSS `<itunes:owner>` block |
| `HOLD_MUSIC_URL` | optional override for the on-call hold music; otherwise pulls from Storage |

## Twilio configuration

1. Buy a number in Twilio (or use existing).
2. In the number's voice config, set:
   - **A call comes in**: webhook → `https://hackersirl.com/api/twilio/voice`, HTTP POST
3. Twilio recordings: leave defaults (Twilio hosts the file; we copy to Storage on submit).

## Cloudflare Access (for /admin)

1. Cloudflare Zero Trust dashboard → Access → Applications → Self-hosted
2. Application domain: `hackersirl.com/admin*` and `hackersirl.com/api/admin/*`
3. Policy: Allow if email matches `ADMIN_EMAIL`
4. Identity provider: One-time PIN by email is enough to start

When Panda hits `/admin/`, Access challenges them, they get a magic-link email,
and after that the browser holds a session cookie. The Functions read the
authenticated email from `Cf-Access-Authenticated-User-Email` to authorize.

## Voice samples (anon preview menu)

The phone flow plays a short MP3 sample of each anon voice before the caller
commits. Drop these into the Storage bucket once at setup:

```
hackersirl-audio/
  voice-samples/
    operator.mp3       (~5-10s)
    trucker.mp3
    anchor.mp3
  hold-music.mp3       (loopable, ideally ~30s)
```

Easiest way: pick a short reference clip ("hey, this is your operator log,
just hold on a sec"), run it through ElevenLabs Speech-to-Speech for each
target voice, save as MP3, upload via the Supabase dashboard.

## Transcription + draft title/desc

CF Pages just rehosts the audio + runs the ElevenLabs anon swap during
the call. Whisper transcription and the draft title/description happen
out-of-band on the quantos-bot Mac via a 5-minute cron:

- Script: `~/.claude/cron/hackersirl-process.sh`
- LaunchAgent: `~/Library/LaunchAgents/com.quantos.hackersirl-process.plist`
- Whisper: `mlx_whisper` (Apple-silicon, model `whisper-large-v3-turbo`)
- Drafting: `claude -p` (uses the local Claude Code subscription, no API key needed)
- Logs: `~/.claude/cron/logs/hackersirl-process.{log,err.log}`

The cron polls `hir_submissions` for `status='ready' AND transcript IS NULL`,
downloads the audio, runs Whisper, drafts a title + description with Claude,
and PATCHes the row. Admin queue auto-shows the new fields on next refresh.
The Mac must be online for processing to happen — backlog will drain when it wakes.

## Once everything is set

1. Call the Twilio number → hear greeting → menu → record handle → record body → review menu → submit
2. Within ~1 min, the submission shows up at `https://hackersirl.com/admin/` as **ready** with transcript + draft title/description
3. Edit, click Publish, the episode appears at `https://hackersirl.com/feed.xml`
4. Submit `https://hackersirl.com/feed.xml` once to Apple Podcasts Connect and once to Spotify for Podcasters; future episodes auto-distribute
