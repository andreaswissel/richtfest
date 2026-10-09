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

- **HTTP:** hashed files under `/assets/` are cached forever (`immutable`); `index.html` and `version.json` are
  revalidated on every load (`no-cache`). A reload always gets the latest build.
- **Build ID:** each web build gets an ID, a hash of its asset file names, so it only changes when the shipped frontend
  changes. It is written into `index.html` (`<meta name="richtfest-build">`) and `dist/version.json`, and shown under
  Settings → System.
- **Open tabs:** the API sends the build ID it serves in the realtime `hello`. A deploy restarts the API, so open tabs
  reconnect within seconds. If the build differs, the top bar shows **New version · Reload**, and the next screen change
  becomes a full page load of the target URL. Filter or search changes on the same screen never reload.
- **Persisted query cache:** the IndexedDB cache remembers which build wrote it. After a deploy, the first boot still
  renders instantly from it, then revalidates every query in the background. Bump `PERSIST_BUSTER` only when cached
  data shapes break; that discards the cache entirely.

## Tools

```bash
bun run --filter '@richtfest/web' budget       # initial JS size check
bun run --filter '@richtfest/web' bench:perf   # full navigation benchmark (Playwright)
```

The docs site is a separate static bundle under `/docs` and does not count towards the Richtfest OS JS budget.
