// EasySub — Persian AI subtitle pipeline (Vercel serverless function)
//
// Two input paths:
//   A) YouTube link  → pull the existing caption track (manual or auto/ASR) via
//                       YouTube's InnerTube API, then translate to Persian.
//   B) Direct media  → transcribe with Groq Whisper, then translate.
//
// Returns plain JSON:  { srt, vtt, cues, model }  on success,
//                      { error, code }            on failure.
//
// Required env var:  GROQ_API_KEY  (free at https://console.groq.com)
// Optional:  WHISPER_MODEL (default whisper-large-v3-turbo)
//            TRANSLATE_MODEL (default llama-3.3-70b-versatile)

export const config = { maxDuration: 60 };

const GROQ = "https://api.groq.com/openai/v1";
const KEY = process.env.GROQ_API_KEY;
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-large-v3-turbo";
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || "llama-3.3-70b-versatile";
const MAX_BYTES = 24 * 1024 * 1024; // Groq Whisper hard limit: 25 MB
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const INNERTUBE_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w";

// All user-facing errors are in Persian
const FA = {
  NO_KEY: "موتور زیرنویس هنوز راه‌اندازی نشده است. کلید GROQ_API_KEY را در تنظیمات Vercel اضافه کنید.",
  NOT_MEDIA: "این لینک یک فایل ویدیو یا صوتی مستقیم نیست. لطفاً یک لینک مستقیم .mp4/.mp3/.wav بدهید یا فایل را آپلود کنید.",
  TOO_LARGE: "فایل بیش از حد بزرگ است (حداکثر ۲۴ مگابایت). یک فایل کوتاه‌تر آپلود کنید.",
  EMPTY: "فایل رسانه‌ای خالی است.",
  NO_SPEECH: "هیچ گفتاری در این رسانه شناسایی نشد.",
  INVALID_URL: "لطفاً یک لینک معتبر http یا https وارد کنید.",
  NO_INPUT: "یک فایل رسانه‌ای آپلود کنید یا یک لینک یوتیوب/مستقیم وارد کنید.",
  DOWNLOAD_FAIL: (s) => `دانلود لینک ناموفق بود (HTTP ${s}). از صحت لینک اطمینان حاصل کنید.`,
  RATE_LIMIT: "محدودیت سرعت سرور رسیده است. چند ثانیه صبر کنید و دوباره امتحان کنید.",
  TOO_LONG: "فایل صوتی بیش از حد طولانی است. یک بخش کوتاه‌تر آپلود کنید.",
  TIMEOUT: "زمان پاسخ به پایان رسید. لطفاً دوباره امتحان کنید یا فایل را مستقیم آپلود کنید.",
  WHISPER_FAIL: (m) => `خطا در رونویسی صدا: ${m}`,
  TRANSLATE_FAIL: (m) => `خطا در ترجمه به فارسی: ${m}`,
  YT_NO_CAPTIONS: "زیرنویس این ویدیوی یوتیوب قابل دریافت نبود. ویدیویی با زیرنویس (CC) امتحان کنید یا فایل را مستقیم آپلود کنید.",
  SERVER: (m) => `خطای سرور: ${m}`,
};

const EXT_MAP = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "mp4",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/flac": "flac",
  "audio/aac": "aac", "audio/x-m4a": "m4a",
  "video/mp4": "mp4", "video/webm": "webm", "video/mpeg": "mpeg",
  "video/quicktime": "mov", "video/x-msvideo": "avi",
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// fetch with a hard timeout so a hung request never stalls the whole function
async function fetchT(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(tm);
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!KEY) return res.status(500).json({ error: FA.NO_KEY, code: "NO_KEY" });

  try {
    const { url, mediaBase64, mimeType } = req.body || {};
    let segments;
    const yid = url ? ytId(url) : null;

    if (yid) {
      segments = await youtubeSegments(yid);
      if (!segments || !segments.length) {
        return res.status(422).json({ error: FA.YT_NO_CAPTIONS, code: "YT_NO_CAPTIONS" });
      }
    } else if (mediaBase64) {
      const mt = (mimeType || "audio/mpeg").split(";")[0].trim();
      const bytes = Buffer.from(mediaBase64, "base64");
      if (!bytes.length) return res.status(400).json({ error: FA.EMPTY, code: "EMPTY" });
      if (bytes.length > MAX_BYTES) return res.status(413).json({ error: FA.TOO_LARGE, code: "TOO_LARGE" });
      segments = await transcribe(bytes, mt);
    } else if (url) {
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: FA.INVALID_URL, code: "INVALID_URL" });
      const r = await fetchT(url, { headers: { "User-Agent": UA } }, 20000);
      if (!r.ok) return res.status(400).json({ error: FA.DOWNLOAD_FAIL(r.status), code: "DOWNLOAD_FAIL" });
      const mt = (mimeType || r.headers.get("content-type") || "audio/mpeg").split(";")[0].trim();
      if (!/^(audio|video)\//i.test(mt)) return res.status(400).json({ error: FA.NOT_MEDIA, code: "NOT_MEDIA" });
      const bytes = Buffer.from(await r.arrayBuffer());
      if (!bytes.length) return res.status(400).json({ error: FA.EMPTY, code: "EMPTY" });
      if (bytes.length > MAX_BYTES) return res.status(413).json({ error: FA.TOO_LARGE, code: "TOO_LARGE" });
      segments = await transcribe(bytes, mt);
    } else {
      return res.status(400).json({ error: FA.NO_INPUT, code: "NO_INPUT" });
    }

    if (!segments || segments.length === 0) {
      return res.status(422).json({ error: FA.NO_SPEECH, code: "NO_SPEECH" });
    }

    const persianTexts = await translateToPersian(segments.map((s) => s.text.trim()));
    const srt = buildSrt(segments, persianTexts);
    const cues = parseSrt(srt);
    return res.status(200).json({ srt, vtt: srtToVtt(srt), cues, model: TRANSLATE_MODEL });

  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/abort/i.test(msg)) return res.status(504).json({ error: FA.TIMEOUT, code: "TIMEOUT" });
    if (/rate.?limit/i.test(msg)) return res.status(429).json({ error: FA.RATE_LIMIT, code: "RATE_LIMIT" });
    if (/too.?long|audio_too_long/i.test(msg)) return res.status(400).json({ error: FA.TOO_LONG, code: "TOO_LONG" });
    return res.status(500).json({ error: FA.SERVER(msg), code: "SERVER" });
  }
}

// ── YouTube helpers ─────────────────────────────────────────────────────────

function ytId(u) {
  const s = String(u || "");
  const m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Get caption tracks via the InnerTube API (Android client — least IP-blocked),
// falling back to scraping the watch page.
async function captionTracks(id) {
  // 1) InnerTube ANDROID client
  try {
    const r = await fetchT(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US" } },
        videoId: id,
      }),
    }, 15000);
    if (r.ok) {
      const j = await r.json();
      const tr = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tr && tr.length) return tr;
    }
  } catch (e) {}

  // 2) InnerTube WEB client
  try {
    const r = await fetchT(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "en", gl: "US" } },
        videoId: id,
      }),
    }, 15000);
    if (r.ok) {
      const j = await r.json();
      const tr = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tr && tr.length) return tr;
    }
  } catch (e) {}

  // 3) Scrape watch page
  try {
    const r = await fetchT(`https://www.youtube.com/watch?v=${id}&hl=en`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cookie": "CONSENT=YES+1" },
    }, 15000);
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/"captionTracks":(\[.*?\])/);
      if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    }
  } catch (e) {}

  return [];
}

async function youtubeSegments(id) {
  const tracks = await captionTracks(id);
  if (!tracks || !tracks.length) return [];

  // Prefer English; otherwise the first track (usually the original language).
  const track = tracks.find((t) => /^en/i.test(t.languageCode || "")) || tracks[0];
  let base = (track.baseUrl || "").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  if (!base) return [];
  if (!/[?&]fmt=/.test(base)) base += "&fmt=json3";

  const cap = await fetchT(base, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } }, 15000);
  if (!cap.ok) return [];
  const data = await cap.json().catch(() => null);
  if (!data || !Array.isArray(data.events)) return [];

  return data.events
    .filter((e) => e.segs && (e.tStartMs != null))
    .map((e) => ({
      start: e.tStartMs / 1000,
      end: (e.tStartMs + (e.dDurationMs || 1500)) / 1000,
      text: e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
}

// ── Groq Whisper transcription ──────────────────────────────────────────────

async function transcribe(bytes, mimeType) {
  const ext = EXT_MAP[mimeType] || "mp3";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), `audio.${ext}`);
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "verbose_json");

  const r = await fetchT(`${GROQ}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  }, 55000);
  const data = await r.json();
  if (!r.ok) throw new Error(FA.WHISPER_FAIL(data?.error?.message || `HTTP ${r.status}`));
  return (data.segments || []).filter((s) => s.text && s.text.trim());
}

// ── Persian translation (LLaMA 3.3 70B) ─────────────────────────────────────

const BATCH_SIZE = 40;

async function translateToPersian(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const chunk = texts.slice(i, i + BATCH_SIZE);
    const translated = await translateChunk(chunk);
    out.push(...translated);
  }
  return out;
}

async function translateChunk(texts) {
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const prompt =
    "You are a Persian subtitle translator. Translate each numbered line to fluent, natural, modern Persian (Farsi).\n" +
    "Rules:\n" +
    "- Output ONLY the translated lines, numbered exactly like the input.\n" +
    "- One translation per line. No extra text, no explanations.\n" +
    "- Keep lines short (max 42 characters) for subtitles.\n\n" +
    numbered;

  const r = await fetchT(`${GROQ}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.15,
      max_tokens: 4096,
    }),
  }, 50000);
  const data = await r.json();
  if (!r.ok) throw new Error(FA.TRANSLATE_FAIL(data?.error?.message || `HTTP ${r.status}`));

  const content = (data.choices?.[0]?.message?.content || "").trim();
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\./.test(l))
    .map((l) => l.replace(/^\d+\.\s*/, "").trim());

  if (lines.length === texts.length) return lines;
  return texts; // non-blocking fallback
}

// ── SRT / VTT helpers ───────────────────────────────────────────────────────

function sec2tc(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(sec)},${String(ms).padStart(3, "0")}`;
}
function pad(n) { return String(n).padStart(2, "0"); }

function buildSrt(segments, translations) {
  return segments
    .map((seg, i) => `${i + 1}\n${sec2tc(seg.start)} --> ${sec2tc(seg.end)}\n${(translations[i] || seg.text).trim()}`)
    .join("\n\n");
}

function tc2sec(tc) {
  const m = tc.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function parseSrt(srt) {
  const cues = [];
  for (const b of srt.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = b.split("\n").filter((l) => l.trim());
    if (lines.length < 2) continue;
    const tcLine = lines.find((l) => l.includes("-->"));
    if (!tcLine) continue;
    const [a, b2] = tcLine.split("-->");
    const txt = lines.slice(lines.indexOf(tcLine) + 1).join("\n").trim();
    if (txt) cues.push({ start: tc2sec(a), end: tc2sec(b2), fa: txt });
  }
  return cues;
}

function srtToVtt(srt) {
  return "WEBVTT\n\n" + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}
