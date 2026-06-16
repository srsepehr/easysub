// EasySub — Vercel Blob client-upload token handler.
//
// The browser can't POST large files through a serverless function (Vercel rejects
// request bodies over ~4.5 MB). Instead the browser uploads the file DIRECTLY to
// Vercel Blob storage; this route only issues a short-lived, scoped upload token.
// The flow:  browser → /api/blob-upload (token) → browser → Blob storage → URL,
// then the browser sends that URL to /api/subtitle, which reads it and transcribes.
//
// Requires Vercel Blob storage enabled on the project (Storage tab → Create →
// Blob), which auto-injects the BLOB_READ_WRITE_TOKEN env var used here.

import { handleUpload } from "@vercel/blob/client";

export const config = { maxDuration: 30 };

// Lightweight abuse guard: the app sends this shared token in clientPayload, and we
// refuse to mint an upload token without it. This deters drive-by/automated POSTs to
// the open endpoint. It is NOT real auth — the static client exposes the value — so
// override it with the UPLOAD_GATE_TOKEN env var if you want a non-public value, and
// add proper server-side auth before a public launch.
const GATE_TOKEN = process.env.UPLOAD_GATE_TOKEN || "easysub-web-upload";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const json = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let ok = false;
        try { ok = !!clientPayload && JSON.parse(clientPayload).gate === GATE_TOKEN; } catch (e) {}
        if (!ok) throw new Error("Unauthorized upload");
        return {
          // Whisper caps at 25 MB; guard the upload to roughly that.
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({}),
        };
      },
      // Fired server-side when the upload finishes; nothing to do here — the
      // subtitle function deletes the blob after it finishes transcribing.
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(json);
  } catch (e) {
    return res.status(400).json({ error: (e && e.message) || "Blob upload failed", code: "BLOB_UPLOAD" });
  }
}
