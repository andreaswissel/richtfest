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

`richtfest-os/apps/web/public/optimization-preview-v1.mp4` is a silent, 1200×630 H.264 export of the actual Three.js optimization walkthrough, at 24 fps and double speed, with a three-second final hold. It uses the landing typography and colors, the live estimate, and a persistent illustrative-example / planner-approval disclaimer. `optimization-preview-v1-poster.jpg` beside it is a matching final-frame poster. The English video is independent of the visitor's language selection.

Both app and landing HTML declare `og:video` with its MIME type and dimensions. The app uses the matching poster for `og:image` and its Twitter large-image card; the offline landing page keeps its original image fallback. This is not a Twitter Player Card.

The shared assets are publicly served at `https://app.richtfest.ai/optimization-preview-v1.mp4` and `https://app.richtfest.ai/optimization-preview-v1-poster.jpg`, without sign-in, independently of the landing page's offline redirects. iMessage supports direct MP4 previews; WhatsApp's documented website preview uses an image thumbnail, so use the poster there and send the MP4 as a video attachment when motion is required. Actual behavior depends on client settings and cached previews. A browser playback or crawler-response check is not a native messaging-app test.

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
