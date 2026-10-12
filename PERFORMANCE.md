---
title: Performance
description: Richtfest OS targets Linear-grade instant navigation. Budgets are enforced, not aspirational.
---

Performance is a first-class feature. This document is the working performance specification for the repository.

## Budgets

| Metric                             | Budget        |
| ---------------------------------- | ------------- |
| Warm navigation commit (p95)       | < 100 ms      |
| Cold navigation commit (p95)       | < 200 ms      |
| Warm settle (p95)                  | < 150 ms      |
| Initial JS                         | < 350 kB gzip |
| First-party API endpoints (p95)    | < 100 ms      |
| API requests per screen navigation | ≤ 6           |

Changes that regress the bench budgets do not ship.

## Rules

- **Never blank the previous screen.** No Suspense fallback on route transitions. The router loads screen code and
  swaps atomically.
- **Data stays off the critical path:** route loaders prefetch into the TanStack Query cache (fire-and-forget), the
  cache is persisted for warm boots, and the server pushes invalidations for freshness.
- **Heavy dependencies** (> ~50 kB gzip) are imported dynamically where they render, never on the boot path.
- **New screens** register in `routes-manifest.ts` and are covered by the perf bench.

## Caching and deploys

- **HTTP:** app HTML and `version.json` use `no-store`. Hashed files under `/assets/` use one-year immutable caching.
  Current files are served locally; older files fall back to the private Railway Bucket's `web-assets/v1/` archive.
  Production startup archives the build before listening and fails if retention is unavailable. Unknown assets return
  a non-HTML, non-cacheable 404; archive outages return a non-cacheable 503. A reload requests the current build.
- **Build ID:** each web build gets an ID, a hash of its asset file names, so it only changes when the shipped frontend
  changes. It is written into `index.html` (`<meta name="richtfest-build">`) and `dist/version.json`.
- **Open tabs:** a nonblocking TanStack Query check fetches `/version.json` once a minute while visible and on tab
  activation. A different build shows **New updates available** above the profile in the desktop navigation rail.
  Only clicking the button reloads, keeping the current URL. Failed checks do not interrupt work or imply an update.
- **Persisted query cache:** IndexedDB stores a short-lived, user/workspace-scoped rendering cache restored after
  authentication. Build-version checks opt out of persistence so a previous boot cannot supply a stale update notice.

## Tools

```bash
bun run --filter '@richtfest/web' budget       # initial JS size check
bun run --filter '@richtfest/web' bench:perf   # full navigation benchmark (Playwright)
```

The docs site is a separate static bundle under `/docs` and does not count towards the Richtfest OS JS budget.
