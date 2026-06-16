// EasySub — Persian AI subtitle pipeline (Vercel serverless function)
//
// Input paths:
//   A) YouTube link  → fetch the existing transcript and translate to Persian.
//                       Supadata is the primary source (reliable from datacenter
//                       IPs); Piped / Invidious / InnerTube are keyless fallbacks.
//                       Caption-based, so this works for ANY video length — no size cap.
//   B) Uploaded file → the browser uploads straight to Vercel Blob storage, we read
//                       it back by URL and transcribe with Groq Whisper (up to ~24 MB).
//   C) Small file (base64) or direct media link → transcribe with Groq Whisper.
//
// Returns plain JSON:  { srt, vtt, cues, model }  on success,
//                      { error, code }            on failure.
//
// Env vars:
//   GROQ_API_KEY          required — free at https://console.groq.com
//   SUPADATA_API_KEY      optional — reliable YouTube transcripts, https://supadata.ai
//   BLOB_READ_WRITE_TOKEN auto-set when you enable Vercel Blob storage on the project
//   WHISPER_MODEL         default whisper-large-v3-turbo
//   TRANSLATE_MODEL       default llama-3.3-70b-versatile

export const config = { maxDuration: 60 };

const GROQ = "https://api.groq.com/openai/v1";
const KEY = process.env.GROQ_API_KEY;
const SUPADATA_KEY = process.env.SUPADATA_API_KEY;
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-large-v3-turbo";
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || "llama-3.3-70b-versatile";
const MAX_BYTES = 24 * 1024 * 1024; // Groq Whisper hard limit: 25 MB
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const INNERTUBE_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w";

// All user-facing errors are in Persian
const FA = {
  NO_KEY: "موتور زیرنویس هنوز راه‌اندازی نشده است. کلید GROQ_API_KEY را در تنظیمات Vercel اضافه کنید.",
  NOT_MEDIA: "این لینک یک فایل ویدیو یا صوتی مستقیم نیست. لطفاً یک لینک مستقیم .mp4/.mp3/.wav بدهید یا فایل را آپلود کنید.",
  TOO_LARGE: "فایل بیش از حد بزرگ است (حداکثر ۲۴ مگابایت). یک فایل کوتاه‌تر آپلود کنید یا لینک یوتیوب بدهید.",
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
    const { url, mediaBase64, mimeType, blobUrl } = req.body || {};
    let segments;
    const yid = url ? ytId(url) : null;

    if (yid) {
      // YouTube — transcript-based, no size/length limit
      segments = await youtubeSegments(yid, url);
      if (!segments || !segments.length) {
        return res.status(422).json({ error: FA.YT_NO_CAPTIONS, code: "YT_NO_CAPTIONS" });
      }
    } else if (blobUrl) {
      // Browser uploaded the file directly to Vercel Blob → read it back by URL.
      if (!/^https?:\/\//i.test(blobUrl)) return res.status(400).json({ error: FA.INVALID_URL, code: "INVALID_URL" });
      const r = await fetchT(blobUrl, {}, 30000);
      if (!r.ok) return res.status(400).json({ error: FA.DOWNLOAD_FAIL(r.status), code: "DOWNLOAD_FAIL" });
      const mt = (mimeType || r.headers.get("content-type") || "audio/mpeg").split(";")[0].trim();
      const bytes = Buffer.from(await r.arrayBuffer());
      if (!bytes.length) return res.status(400).json({ error: FA.EMPTY, code: "EMPTY" });
      if (bytes.length > MAX_BYTES) return res.status(413).json({ error: FA.TOO_LARGE, code: "TOO_LARGE" });
      segments = await transcribe(bytes, mt);
      // Best-effort cleanup so uploaded media doesn't pile up in Blob storage.
      try { const { del } = await import("@vercel/blob"); await del(blobUrl); } catch (e) {}
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
//
// YouTube heavily rate-limits / bot-blocks requests from cloud datacenter IPs
// (Vercel, AWS, GCP), so hitting youtube.com directly from a serverless function
// frequently returns NO caption tracks. Supadata is a purpose-built transcript API
// that handles the IP-blocking on its side, so we try it first; the keyless
// Piped / Invidious / InnerTube paths are best-effort fallbacks.

function ytId(u) {
  const s = String(u || "");
  const m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

const decodeEnt = (s) => String(s || "")
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "");

// Parse any caption payload (JSON3, XML timedtext, or WebVTT) into segments.
function parseCaptions(raw) {
  const text = String(raw || "");
  if (!text.trim()) return [];

  // JSON3 (events[])
  if (/^\s*\{/.test(text)) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data.events)) {
        return data.events
          .filter((e) => e.segs && e.tStartMs != null)
          .map((e) => ({
            start: e.tStartMs / 1000,
            end: (e.tStartMs + (e.dDurationMs || 1500)) / 1000,
            text: e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim(),
          }))
          .filter((s) => s.text);
      }
    } catch (e) {}
  }

  // WebVTT
  if (/^\s*WEBVTT/.test(text)) {
    const segs = [];
    const re = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|\n\s*\d{1,2}:|\s*$)/g;
    let m;
    const toSec = (h, mm, ss, ms) => (+(h || 0)) * 3600 + +mm * 60 + +ss + +ms / 1000;
    while ((m = re.exec(text)) !== null) {
      const start = toSec((m[1] || "").replace(":", ""), m[2], m[3], m[4]);
      const end = toSec((m[5] || "").replace(":", ""), m[6], m[7], m[8]);
      const body = decodeEnt(m[9].replace(/\n/g, " ")).replace(/\s+/g, " ").trim();
      if (body) segs.push({ start, end, text: body });
    }
    if (segs.length) return segs;
  }

  // TTML (<p begin="..." end="...">) — Piped and some YouTube tracks serve this
  if (/<tt[\s>]|<p\b[^>]*\bbegin=/.test(text)) {
    const ttmlTime = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      if (/^\d+(\.\d+)?s$/.test(s)) return parseFloat(s);          // "1.5s"
      if (/^\d+(\.\d+)?ms$/.test(s)) return parseFloat(s) / 1000;  // "100ms"
      const c = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/); // HH:MM:SS.mmm
      if (c) return (+(c[1] || 0)) * 3600 + +c[2] * 60 + +c[3] + (c[4] ? parseFloat(`0.${c[4]}`) : 0);
      const f = parseFloat(s);
      return isNaN(f) ? null : f;
    };
    const ttmlSegs = [];
    const tre = /<p\b[^>]*\bbegin="([^"]+)"[^>]*?(?:\bend="([^"]+)")?[^>]*>([\s\S]*?)<\/p>/g;
    let tm;
    while ((tm = tre.exec(text)) !== null) {
      const start = ttmlTime(tm[1]);
      if (start == null) continue;
      let end = ttmlTime(tm[2]);
      if (end == null) end = start + 1.5;
      const body = decodeEnt(tm[3].replace(/<br\s*\/?>/gi, " ").replace(/\n/g, " ")).replace(/\s+/g, " ").trim();
      if (body) ttmlSegs.push({ start, end, text: body });
    }
    if (ttmlSegs.length) return ttmlSegs;
  }

  // XML timedtext (<text start="" dur="">)
  const xmlSegs = [];
  const re = /<text[^>]*\bstart="([\d.]+)"[^>]*?(?:\bdur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2] || "1.5");
    const body = decodeEnt(m[3].replace(/\n/g, " ")).replace(/\s+/g, " ").trim();
    if (body) xmlSegs.push({ start, end: start + dur, text: body });
  }
  return xmlSegs;
}

// Primary — Supadata transcript API (handles datacenter IP-blocking on its side).
// GET /v1/youtube/transcript → { content: [{ text, offset(ms), duration(ms) }], ... }
async function supadataSegments(id, url) {
  if (!SUPADATA_KEY) return [];
  const q = url ? `url=${encodeURIComponent(url)}` : `videoId=${encodeURIComponent(id)}`;
  try {
    const r = await fetchT(`https://api.supadata.ai/v1/youtube/transcript?${q}&text=false`, {
      headers: { "x-api-key": SUPADATA_KEY },
    }, 25000);
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    const content = j && j.content;
    if (!Array.isArray(content) || !content.length) return [];
    return content
      .map((c) => {
        const startMs = c.offset != null ? c.offset : (c.start != null ? c.start : 0);
        const durMs = c.duration != null ? c.duration : (c.dur != null ? c.dur : 1500);
        return {
          start: startMs / 1000,
          end: (startMs + durMs) / 1000,
          text: String(c.text || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((s) => s.text);
  } catch (e) {
    return [];
  }
}

// Public Piped API instances (return subtitle URLs). Tried in order.
const PIPED_HOSTS = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.leptons.xyz",
  "https://api.piped.yt",
];

// Public Invidious instances (return caption VTT). Tried in order.
const INVIDIOUS_HOSTS = [
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net",
  "https://invidious.fdn.fr",
  "https://yewtu.be",
];

function pickEnglish(list, langOf) {
  return list.find((x) => /^en/i.test(langOf(x) || "")) || list[0];
}

// Fallback 1 — Piped: GET /streams/{id} → subtitles[{url, code}]
async function pipedSegments(id) {
  for (const host of PIPED_HOSTS) {
    try {
      const r = await fetchT(`${host}/streams/${id}`, { headers: { Accept: "application/json" } }, 8000);
      if (!r.ok) continue;
      const j = await r.json();
      const subs = j?.subtitles;
      if (!Array.isArray(subs) || !subs.length) continue;
      const pick = pickEnglish(subs, (s) => s.code || s.language);
      if (!pick?.url) continue;
      const cr = await fetchT(pick.url, { headers: { "User-Agent": UA } }, 8000);
      if (!cr.ok) continue;
      const segs = parseCaptions(await cr.text());
      if (segs.length) return segs;
    } catch (e) {}
  }
  return [];
}

// Fallback 2 — Invidious: GET /api/v1/captions/{id} → captions[{languageCode, url}]
async function invidiousSegments(id) {
  for (const host of INVIDIOUS_HOSTS) {
    try {
      const r = await fetchT(`${host}/api/v1/captions/${id}`, { headers: { Accept: "application/json" } }, 8000);
      if (!r.ok) continue;
      const j = await r.json();
      const caps = j?.captions;
      if (!Array.isArray(caps) || !caps.length) continue;
      const pick = pickEnglish(caps, (c) => c.languageCode || c.language_code);
      const capUrl = pick?.url ? (pick.url.startsWith("http") ? pick.url : host + pick.url) : null;
      if (!capUrl) continue;
      const cr = await fetchT(capUrl, { headers: { "User-Agent": UA } }, 8000);
      if (!cr.ok) continue;
      const segs = parseCaptions(await cr.text());
      if (segs.length) return segs;
    } catch (e) {}
  }
  return [];
}

// Fallback 3 — Direct YouTube InnerTube (best-effort; usually blocked from cloud IPs)
async function innertubeSegments(id) {
  const clients = [
    { headers: { "Content-Type": "application/json", "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" },
      key: INNERTUBE_KEY, ctx: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US" } },
    { headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 SamsungBrowser/2.1 TV Safari/537.36" },
      key: null, ctx: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en", gl: "US" } },
    { headers: { "Content-Type": "application/json", "User-Agent": UA },
      key: INNERTUBE_KEY, ctx: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "en", gl: "US" } },
  ];
  for (const c of clients) {
    try {
      const u = `https://www.youtube.com/youtubei/v1/player${c.key ? `?key=${c.key}` : ""}`;
      const r = await fetchT(u, { method: "POST", headers: c.headers, body: JSON.stringify({ context: { client: c.ctx }, videoId: id }) }, 9000);
      if (!r.ok) continue;
      const j = await r.json();
      const tr = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tr || !tr.length) continue;
      const track = pickEnglish(tr, (t) => t.languageCode);
      let base = (track.baseUrl || "").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      if (!base) continue;
      if (!/[?&]fmt=/.test(base)) base += "&fmt=json3";
      const cap = await fetchT(base, { headers: { "User-Agent": UA } }, 9000);
      if (!cap.ok) continue;
      const segs = parseCaptions(await cap.text());
      if (segs.length) return segs;
    } catch (e) {}
  }
  return [];
}

// Try every caption source in order of reliability from a datacenter IP.
async function youtubeSegments(id, url) {
  let segs = await supadataSegments(id, url);
  if (segs.length) return segs;
  segs = await pipedSegments(id);
  if (segs.length) return segs;
  segs = await invidiousSegments(id);
  if (segs.length) return segs;
  segs = await innertubeSegments(id);
  if (segs.length) return segs;
  return [];
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
