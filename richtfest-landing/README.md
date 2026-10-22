# Richtfest Landing

Static marketing page (EN/DE), independent of the Richtfest OS build and served by the existing `richtfest-monorepo` Railway service.

**Offline until relaunch.** The API currently redirects the marketing domains to `app.richtfest.ai` and `/landing/` to `/` (see `richtfest-os/apps/api/src/server.ts`). To relaunch, serve this directory again at `/landing/` and at `/` on `richtfest.ai`, `richtfest.si`, `www.richtfest.si` and `richtfest.andreaswissel.com`.

- `index.html`: the page. Three.js (r128) loads from jsDelivr for the interactive house; everything else is inline.
- `og-image.png`, `og-image-de.png`: 1200×630 share images. Open Graph image paths are relative so they work at both `/` and `/landing/`.
- `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`: icons.
- Sign in links to the app subdomain on custom domains, and to the root of the Railway preview host.
- Language follows the saved choice, then the browser language. Toggle in the nav.

Preview locally: `python3 -m http.server -d richtfest-landing 8766`, then open http://localhost:8766.

## Optimization video preview

`og-video.mp4` is a silent, 1200×630 H.264 export of the actual Three.js optimization walkthrough, at 24 fps and double speed, with a three-second final hold. It uses the landing typography and colors, the live estimate, and a persistent illustrative-example / planner-approval disclaimer. `og-video-poster.jpg` is a matching final-frame poster. The English video is independent of the visitor's language selection.

The page declares `og:video` with its MIME type and dimensions. The existing `og:image` and Twitter large-image card remain the fallback: adding `og:video` does **not** guarantee inline playback or autoplay on a sharing platform, and this is not a Twitter Player Card.

**Not live while the landing page is offline.** At relaunch, `https://richtfest.ai/og-video.mp4` must serve the MP4 publicly over HTTPS with `Content-Type: video/mp4`, without sign-in or an app redirect. If the canonical marketing domain changes, update both video URL tags. Test the actual target platform after publication; a local video playback check is not a social crawler test.

### Regenerate

Requires Node.js 22+, ffmpeg, agent-browser/Chromium, and network access for the page's existing fonts and Three.js CDN scripts. From the repository root in an Amp orb:

```sh
amp orb service start landing-preview --command 'python3 -m http.server 8766 --directory richtfest-landing' --port 8766 --portal
agent-browser --session ogvideo open http://localhost:8766
agent-browser --session ogvideo set viewport 1200 630 2
node scripts/export-landing-video.mjs "$(agent-browser --session ogvideo get cdp-url)"
agent-browser --session ogvideo close
```

Use a dedicated browser session: the exporter reloads its first HTTP page, selects English, applies a capture-only layout, and advances the page's timers and animation frames manually. It records every frame even when software WebGL is slower than realtime. It then restores the page by reloading it. No capture layout or timing changes are shipped to visitors, and no new runtime dependencies are added to the landing page.
