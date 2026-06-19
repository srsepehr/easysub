# EasySub — Design Context (for making UI/design changes)

Hand this whole file to Claude **together with `easysubapp/index.html`**. It explains
what the app is, how it's built, and the rules to follow so design changes stay
consistent and don't break the (build-less) app.

---

## 1. What it is
**EasySub** is a Persian (Farsi) AI video-subtitling web app. A user pastes a
YouTube link or uploads a video, and the app generates **Persian subtitles** and
shows them on a custom player. The whole front-end is **one file**:
`easysubapp/index.html`. The visual style is a dark **"Astra liquid-glass"** theme.

## 2. Tech stack & hard constraints (read before editing)
- **Single file, NO build step.** All UI lives in `easysubapp/index.html`
  (~3,760 lines). It is served as-is. There is no webpack/vite/npm build.
- **React 18 via CDN UMD** + **Babel Standalone** transpiles JSX **in the browser**
  at runtime, inside one big `<script type="text/babel"> … </script>` block.
  - ⇒ Write **JSX/ES2020**. Do **not** use TypeScript, imports/exports, or JSX
    fragments syntax that Babel-standalone can't parse. Use `React.useState`,
    `React.useEffect`, etc. (React is global, not imported).
- **Tailwind via CDN** (`cdn.tailwindcss.com`) with an inline `tailwind.config`
  in the `<head>` (see colors/fonts below). Style with Tailwind utility classes.
- **Direction is RTL / language is Persian** by default (`<html dir="rtl" lang="fa">`).
  The app is **bilingual** (fa/en) — see the `t()` helper. Keep both languages.
- Other CDN libs already loaded: **framer-motion** (`window.Motion`), **hls.js**,
  **YouTube IFrame API**, **Spline viewer**, **Supabase**, Google Identity.
- After ANY edit, it must still transpile. Validate locally with:
  ```bash
  node -e 'const fs=require("fs"),b=require("@babel/core");
  const m=fs.readFileSync("easysubapp/index.html","utf8").match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
  b.transformSync(m[1],{presets:[["@babel/preset-react"]],filename:"a.jsx"});console.log("JSX OK")'
  ```

## 3. Design system

### Fonts (Google Fonts, loaded in `<head>`)
- **Vazirmatn** — Persian/UI body font (`font-sans`, used when `lang=fa`).
- **Sora** — Latin body font (swapped in when `lang=en`).
- **Instrument Serif** — display/serif accent (`font-display`).

### Colors (from inline `tailwind.config`, ~line 19–36)
| Tailwind name | Hex | Use |
|---|---|---|
| `base` | `#0B0B0C` | page background (near-black) |
| `surface` | `#141416` | cards/panels |
| `surface2` | `#1A1A1C` | raised panels |
| `brandgray` | `#1A1A1A` | subtle fills |
| `brand` | `#FFFFFF` | primary accent = **white** (buttons, highlights) |
| `muted` | `#8E8E8E` | secondary text |
- Body text default `#FAFAFA`. **Selection highlight is lime `#9FFF00`** (`::selection`).
- Primary buttons = **white bg / black text**; secondary = `liquid-glass` (see below).

### The signature look: `liquid-glass` (CSS in the `<style>` block, ~line 260–361)
- `.liquid-glass` — frosted translucent panel: faint white bg, `backdrop-filter: blur(4px)`,
  inset top highlight, and a gradient **border drawn via a `::before` mask**. Used for
  most chips, secondary buttons, cards.
- `.liquid-glass-strong` — same idea, heavier `blur(50px)`, for modals/important panels.
- Use these classes (often with `rounded-full` / `rounded-[1.6rem]`) instead of plain
  borders to stay on-theme. **Don't add hard 1px borders;** the theme is borderless glass.

### Motion & misc
- Keyframes: `heroZoom`, `fadeUp` (`.animate-fade-up`), `shake` (`.btn-shake`).
  Respect `prefers-reduced-motion` (already globally handled, ~line 353).
- Focus-visible outlines are themed (~line 337). Custom thin scrollbars; `.no-scrollbar` to hide.

## 4. File map of `index.html` (section comment markers → line)
| Section | ~Line | Contains |
|---|---|---|
| `<head>` config + CDN + `tailwind.config` | 1–58 | fonts, colors, blob uploader |
| `<style>` (liquid-glass, animations) | 260–361 | **all custom CSS** |
| `lib.jsx` | 368 | helpers: `t()`, `fa()`, `Ic`, auth/library localStorage, icons map |
| `chrome.jsx` | 1121 | `Header`, `Footer`, nav, language toggle |
| `home.jsx` | 1405 | `HomePage` (hero/landing) |
| Plans page | 1555 | `PlansPage` (pricing) |
| `demo.jsx` | 1927 | `DemoPage` |
| `browse.jsx` | 2057 | `CategoriesPage`, `CategoryPage` |
| `watch.jsx` | 2213 | `WatchPage` + **`SubtitlePlayer`** (video + subtitle overlay + controls) |
| `studio.jsx` | 2569 | `StudioPage` (paste link / upload, runs the pipeline) |
| `auth.jsx` | 2914 | `LoginPage`, `SignupPage`, `ForgotPasswordPage` |
| `profile.jsx` | 3304 | `ProfilePage` |
| `app.jsx` (router + mount) | 3595 | hash router, page switch (~3725), `Header`/`Footer` wrap |

### Routing
Hash-based (`#/path`). `navigate("/watch/<id>")` sets `window.location.hash`.
Page switch is a chain of `route.page === "…"` (~line 3725).

## 5. Conventions you MUST follow when editing UI
- **Bilingual text:** never hardcode a bare string in JSX. Use
  `t("متن فارسی", "English text")` (helper at line 387). Persian first, English second.
- **Numbers:** wrap user-facing digits with `fa(n)` (line 605) so they render as
  Persian digits when `lang=fa`.
- **Icons:** use `<Ic name="play" size={16} />`. Icons are Lucide-style SVG path
  fragments in the **`ICONS` map** (search `function Ic`, ~line 665, and the map just
  above it). To add an icon, add `name: <><path …/></>` to that map, then use it.
- **RTL:** layout is RTL. Use logical Tailwind classes (`ms-auto`, `ps-4`, `inset-x-*`)
  rather than left/right where possible. Set `dir="ltr"` only on things like timelines.
- **Styling:** prefer existing patterns — `liquid-glass` panels, `rounded-full`
  pills, white primary buttons, `text-white/70` for muted text.
- Keep components as plain functions using `React.useState/useEffect` (no hooks import).

## 6. Backend (only if a change needs data) — not design
- `api/subtitle.js` — serverless: YouTube captions (Supadata) / Whisper transcription
  + Persian translation (Groq `llama-3.3-70b-versatile`). Returns `{ srt, vtt, cues }`
  where each cue is `{ start, end, fa }` (seconds + Persian text).
- `api/blob-upload.js` — Vercel Blob upload token for large files.
- Env vars: `GROQ_API_KEY`, `SUPADATA_API_KEY`, `BLOB_READ_WRITE_TOKEN`.
- Config: `vercel.json` (subtitle function `maxDuration: 60`).

## 7. Good first design changes (examples)
- Change accent color: edit `brand` / `::selection` and primary button classes.
- Restyle the player controls: `SubtitlePlayer` (~line 2569 in watch.jsx area, control
  bar ~line 2400+) — play/pause, captions toggle, speed, fullscreen, sync nudge.
- Tweak the hero: `HomePage` (~line 1405).
- Adjust glass intensity: `.liquid-glass` blur/opacity in `<style>`.

**Always keep:** the build-less constraint, RTL, bilingual `t()`, and the
liquid-glass aesthetic. Validate JSX (section 2) before considering a change done.
