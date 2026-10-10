# Richtfest Landing

Static marketing page (EN/DE), independent of the Richtfest OS build. Not served by the `richtfest-monorepo` Railway service yet.

- `index.html`: the page. Three.js (r128) loads from jsDelivr for the interactive house; everything else is inline.
- `og-image.png`, `og-image-de.png`: 1200×630 share images. `og:image` uses a root-relative path; switch it to an absolute URL once the public domain is set.
- `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`: icons.
- Sign in links to `app.<current domain>` at runtime.
- Language follows the saved choice, then the browser language. Toggle in the nav.

Preview locally: `python3 -m http.server -d richtfest-landing 8766`, then open http://localhost:8766.
