// EasySub — Persian AI subtitle pipeline (Vercel serverless function)
//
// Takes a media file (small upload, base64) or a direct media URL, sends it to
// Google Gemini (free tier — generous, multimodal), and gets back accurate
// Persian subtitles in SRT format. Gemini transcribes the spoken audio AND
// translates it to fluent Persian in a single call, with timestamps.
//
// Required env var:  GEMINI_API_KEY   (free key from https://aistudio.google.com/apikey)
// Optional env var:  GEMINI_MODEL     (default: gemini-2.0-flash)

export const config = { maxDuration: 60 };

const API = "https://generativelanguage.googleapis.com";
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const INLINE_LIMIT = 60 * 1024 * 1024; // bytes — above this, use the File API

const PROMPT = [
  "You are EasySub, an expert Persian (Farsi) subtitle engine.",
  "Listen to the attached media. Transcribe the spoken words, then translate them into natural, fluent, modern Persian (Farsi).",
  "Output ONLY a valid SRT subtitle file — nothing else, no commentary, no code fences.",
  "Rules:",
  "- Detect the spoken language automatically (it may be English, Arabic, etc.).",
  "- Each cue: an incrementing index, a timestamp line `HH:MM:SS,mmm --> HH:MM:SS,mmm`, then the Persian text.",
  "- Keep cues short (one short sentence or clause, max ~42 characters per line, max 2 lines).",
  "- Timestamps must follow the real audio timing as closely as possible and must not overlap.",
  "- The subtitle text must be in Persian only. Do not include the original language.",
  "- If there is no speech, return an empty response.",
].join("\n");

function isYouTubeUrl(url) {
  return /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)[\w-]{11}/.test(String(url || ""));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!KEY) {
    return res.status(500).json({
      error: "Subtitle engine is not configured yet. Add a free GEMINI_API_KEY in your Vercel project settings.",
      code: "NO_KEY",
    });
  }

  try {
    const { url, mediaBase64, mimeType } = req.body || {};
    let bytes, mt;

    // ---- YouTube: Gemini reads the video straight from the URL (no download) ----
    if (url && isYouTubeUrl(url)) {
      // Normalize to a clean canonical watch URL, dropping ?si=, &t=, playlist params, etc.
      const vidMatch = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
      const cleanUrl = vidMatch ? "https://www.youtube.com/watch?v=" + vidMatch[1] : String(url).split("&")[0];
      const srt = await generateSrt({ file_data: { mime_type: "video/mp4", file_uri: cleanUrl } });
      if (!srt.trim()) {
        return res.status(422).json({ error: "No speech was detected in this video.", code: "NO_SPEECH" });
      }
      const cues = parseSrt(srt);
      return res.status(200).json({ srt, vtt: srtToVtt(srt), cues, model: MODEL });
    }

    if (mediaBase64) {
      mt = mimeType || "video/mp4";
      bytes = Buffer.from(mediaBase64, "base64");
    } else if (url) {
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Please provide a valid http(s) media URL." });
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 EasySub" } });
      if (!r.ok) return res.status(400).json({ error: "Could not download that link (HTTP " + r.status + ")." });
      mt = (mimeType || r.headers.get("content-type") || "video/mp4").split(";")[0].trim();
      if (!/^(audio|video)\//i.test(mt)) {
        return res.status(400).json({
          error: "That link isn't a direct audio/video file (it looks like a web page). Paste a direct .mp4/.mp3 link, or upload the file.",
          code: "NOT_MEDIA",
        });
      }
      bytes = Buffer.from(await r.arrayBuffer());
    } else {
      return res.status(400).json({ error: "Provide a media file or a direct media URL." });
    }

    if (!bytes || bytes.length === 0) return res.status(400).json({ error: "Empty media." });

    // Build the media part — inline for small files, File API for large ones.
    let mediaPart;
    if (bytes.length <= INLINE_LIMIT) {
      mediaPart = { inline_data: { mime_type: mt, data: bytes.toString("base64") } };
    } else {
      const file = await uploadToGemini(bytes, mt);
      await waitActive(file.name);
      mediaPart = { file_data: { mime_type: mt, file_uri: file.uri } };
    }

    const srt = await generateSrt(mediaPart);
    if (!srt.trim()) {
      return res.status(422).json({ error: "No speech was detected in this media.", code: "NO_SPEECH" });
    }
    const cues = parseSrt(srt);
    return res.status(200).json({ srt, vtt: srtToVtt(srt), cues, model: MODEL });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

// ---- Gemini calls ----------------------------------------------------------

async function generateSrt(mediaPart) {
  const r = await fetch(`${API}/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [mediaPart, { text: PROMPT }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || ("Gemini error " + r.status));
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  return stripFences(text);
}

async function uploadToGemini(bytes, mimeType) {
  // Resumable upload — start
  const start = await fetch(`${API}/upload/v1beta/files?key=${KEY}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "easysub-upload" } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini File API did not return an upload URL.");

  // Resumable upload — bytes + finalize
  const fin = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  const data = await fin.json();
  if (!fin.ok) throw new Error(data?.error?.message || "File upload failed.");
  return data.file; // { name, uri, state, ... }
}

async function waitActive(name) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${API}/v1beta/${name}?key=${KEY}`);
    const f = await r.json();
    if (f.state === "ACTIVE") return f;
    if (f.state === "FAILED") throw new Error("Gemini failed to process the uploaded media.");
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("Timed out waiting for media to be processed.");
}

// ---- SRT/VTT helpers -------------------------------------------------------

function stripFences(s) {
  return s.replace(/^```(?:srt)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function tc2sec(tc) {
  const m = tc.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

function parseSrt(srt) {
  const cues = [];
  const blocks = srt.replace(/\r/g, "").split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    const tcLine = lines.find((l) => l.includes("-->"));
    if (!tcLine) continue;
    const [a, b2] = tcLine.split("-->");
    const txt = lines.slice(lines.indexOf(tcLine) + 1).join("\n").trim();
    if (!txt) continue;
    cues.push({ start: tc2sec(a), end: tc2sec(b2), fa: txt });
  }
  return cues;
}

function srtToVtt(srt) {
  return "WEBVTT\n\n" + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}
