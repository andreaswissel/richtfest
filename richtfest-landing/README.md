# Richtfest Landing

Static marketing page (EN/DE), independent of the Richtfest OS build and served by the existing `richtfest-monorepo` Railway service.

- The Railway preview is available at `/landing/` on the service's public domain.
- Requests to `richtfest.si/` serve this page once the domain's DNS is active.

- `index.html`: the page. Three.js (r128) loads from jsDelivr for the interactive house; everything else is inline.
- `og-image.png`, `og-image-de.png`: 1200×630 share images. Open Graph image paths are relative so they work at both `/` and `/landing/`.
- `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`: icons.
- Sign in links to the app subdomain on custom domains, and to the root of the Railway preview host.
- Language follows the saved choice, then the browser language. Toggle in the nav.

Preview locally: `python3 -m http.server -d richtfest-landing 8766`, then open http://localhost:8766.
