# EasySub — یادگیری بدون مرز

**EasySub** is a Persian (Farsi) AI video-subtitling web app. Paste a media link or
upload a clip, and EasySub transcribes the speech and translates it into fluent
Persian subtitles — then plays the video with live Persian captions you can watch
and download (`.srt` / `.vtt`).

The interface is a multi-page, RTL React app built on the **Astra** liquid-glass
design system (monochrome white-on-black, full-bleed video, frosted-glass chrome,
Instrument Serif + Vazirmatn/Sora type, EN/FA language toggle).

## How it works

```
video / link ──▶ /api/subtitle ──▶ Google Gemini (free, multimodal) ──▶ Persian SRT ──▶ player
```

- **Frontend** — `index.html`, a single self-contained file (React 18 + Babel
  standalone + Tailwind via CDN; all images inlined as base64). Hash-routed
  pages: Home, Categories, Watch, **Studio** (upload), Demo, Login/Signup, Profile.
- **Backend** — `api/subtitle.js`, a Vercel serverless function. It sends the
  audio/video to **Google Gemini 2.0 Flash**, which transcribes *and* translates
  to Persian in one call, returning timestamped subtitles. No other services,
  no database.

## Deploy on Vercel

1. Import this repo into Vercel (Framework preset: **Other**, root directory empty).
2. Add one environment variable:
   - `GEMINI_API_KEY` — a **free** key from <https://aistudio.google.com/apikey>
   - *(optional)* `GEMINI_MODEL` — defaults to `gemini-2.0-flash`
3. Deploy. The static site is served from `/`, the function from `/api/subtitle`.

Without the key the UI still runs; the Studio shows a clear "add your key" message.

## Local development

```sh
npm i -g vercel
vercel dev          # serves index.html + /api/subtitle with your local env
```

Set `GEMINI_API_KEY` in a `.env` (or via `vercel env`) first.

## Notes & limits

- **Direct uploads** are capped at ~4 MB (Vercel's serverless request-body limit) —
  use short clips, or paste a **direct** media URL (`.mp4`/`.mp3`) which the
  function fetches server-side (larger files go through Gemini's File API).
- **YouTube / web-page links are not supported** — those aren't direct media files
  and need a separate extraction worker, which Vercel's serverless limits don't fit.
- Subtitle timing follows Gemini's best-effort timestamps; great for clips and
  lectures, not frame-accurate broadcast captioning.
