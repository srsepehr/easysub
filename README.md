# EasySub

Persian AI subtitling app. A single static `index.html` (React 18 via Babel
standalone + Tailwind CDN) plus Vercel serverless functions under
`easysubapp/api/`. Groq powers Whisper transcription and LLaMA 3.3 70B
Persian translation.

Live: https://easysub-srtt.vercel.app

## How a request flows

- **YouTube link** → `api/subtitle.js` fetches the existing transcript and
  translates it to Persian. Because it's caption-based, this works for **any
  video length with no size limit**. Sources are tried in order of reliability
  from a datacenter IP: **Supadata** (primary) → Piped → Invidious → InnerTube.
- **Uploaded file** → the browser uploads it **directly to Vercel Blob storage**
  (bypassing Vercel's ~4.5 MB serverless request-body limit); the function reads
  it back by URL and transcribes it with Groq Whisper (up to ~24 MB). Files under
  3 MB still work without Blob via an inline base64 path.
- **Direct media link** (`.mp4/.mp3/.wav`) → downloaded server-side and
  transcribed (up to ~24 MB — Groq Whisper's hard limit).

## Environment variables (Vercel → Settings → Environment Variables)

| Variable | Required | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | **yes** | Whisper transcription + Persian translation. Free at https://console.groq.com |
| `SUPADATA_API_KEY` | recommended | Reliable YouTube transcripts from datacenter IPs. Free tier at https://supadata.ai. Without it, YouTube falls back to best-effort keyless sources (often blocked on Vercel). |
| `BLOB_READ_WRITE_TOKEN` | for large uploads | Auto-injected when you enable Blob storage (below). Without it, uploads are capped at ~3 MB. |
| `UPLOAD_GATE_TOKEN` | optional | Shared token the app sends in the Blob upload request; the `/api/blob-upload` route rejects requests without it. Defaults to `easysub-web-upload`. Override it (and the matching value in `index.html`) for a non-public value. This is a drive-by deterrent, not real auth — add server-side auth before a public launch. |
| `WHISPER_MODEL` | no | Defaults to `whisper-large-v3-turbo`. |
| `TRANSLATE_MODEL` | no | Defaults to `llama-3.3-70b-versatile`. |

## Enabling large file uploads (Vercel Blob)

1. Vercel project → **Storage** → **Create Database** → **Blob**.
2. Connect it to the project. This auto-adds `BLOB_READ_WRITE_TOKEN`.
3. Redeploy.

Uploaded blobs are deleted automatically once transcription finishes.

## Enabling reliable YouTube (Supadata)

1. Create a free key at https://supadata.ai.
2. Add `SUPADATA_API_KEY` in Vercel → Environment Variables.
3. Redeploy.

## Local notes

- `npm install` pulls `@vercel/blob` (used by `api/blob-upload.js` and the
  blob-cleanup step in `api/subtitle.js`).
- The browser loads the Blob client uploader lazily from `esm.sh` since the app
  has no build step.
