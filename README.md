# Richtfest

Richtfest is a Bun workspace containing the company OS, business apps, shared domain packages, and the exported Fumadocs documentation site. Railway runs the API, web bundle, and docs from one service backed by Railway Postgres and a private S3-compatible Railway Bucket.

## Local setup

Install Bun 1.3.8 or newer, then install the workspace dependencies:

```bash
bun install
cp .env.example .env
```

Set `DATABASE_URL` to a local PostgreSQL database and change `BETTER_AUTH_SECRET` to a random value of at least 32 characters. Apply the schema and start the API with:

```bash
bun run db:migrate
bun run dev
```

The API listens on `http://localhost:3000`. The web app runs separately during development with `bun run --filter @richtfest/web dev`; its Vite proxy forwards `/api` to the API. Build both served static bundles with `bun run build`. The API health endpoint is `GET /health`.

Keep `reference-project/`, `context/`, `.data/`, `.env`, and generated output local. They are excluded from Git and Docker build contexts. The local file adapter stores development/test files under `FILE_STORAGE_PATH`; production source files belong in the private Railway Bucket, never in the repository.

## Railway setup

The Railway project `richtfest-os` is defined in `.railway/railway.ts` (Railway Infrastructure as Code): one service named `richtfest-monorepo`, a Railway Postgres service, and the private Railway Bucket `richtfest-files`, all in EU West (Amsterdam). Railway does not read this file during deploys, so do not create services from the Railway dashboard's GitHub import; it stages one failing service per workspace package. Apply the file with the Railway CLI instead:

```bash
railway login && railway init --name richtfest-os   # first time only; later: railway link
railway config plan                                  # review; omitted resources are deleted
railway config apply
railway variables --service richtfest-monorepo --set "BETTER_AUTH_SECRET=$(openssl rand -base64 48)" \
  --set "AI_CONNECTION_ENCRYPTION_KEY=$(openssl rand -base64 32)" --set "RESEND_API_KEY=…" --set "RESEND_FROM=…"
railway domain --service richtfest-monorepo --port 3000
```

After that, every push to `main` deploys `richtfest-monorepo` from the root `Dockerfile`; the container runs database migrations and then starts the API. The API serves the built web bundle and the exported Fumadocs site at `/docs` after the backend static/auth mount is present.

The file wires `NODE_ENV=production`, `DATABASE_URL` to Postgres, `BETTER_AUTH_URL` to the generated public domain, and the Bucket variables `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`, and `ENDPOINT` to the Railway Bucket, and pins `PORT=3000` to match the Dockerfile and the domain's target port. Secrets are marked `preserve()` and set once with `railway variables`, never committed. The bucket remains private; the API uses presigned downloads and multipart uploads with virtual-host-style endpoint URLs. There is no production volume mount and no AWS or Neon dependency. The CLI aliases, when a provider-neutral S3-compatible tool requires them, are `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, and `AWS_ENDPOINT_URL`.

Uploaded objects use application-generated unique keys and database file/version records. That pairing preserves revisions even though the bucket itself does not provide provider-side versioning, object locks, or server-side encryption. The database dump therefore preserves the object metadata and revision relationships; bucket bytes must be exported separately through the approved S3-compatible object tooling and stored with the database backup. This repository does not perform a live bucket transfer during backup or restore.

Magic-link invitations require a verified Resend sender. Set both `RESEND_API_KEY` and `RESEND_FROM`; `RESEND_FROM` must use a domain or address verified in Resend. Production fails closed when delivery is not configured. OpenAI and Anthropic connections also require `AI_CONNECTION_ENCRYPTION_KEY` (a base64-encoded 32-byte key). Credential presence is reported separately from provider execution readiness; the execution adapters remain unavailable until implemented.

Keep secrets in Railway variables or a local `.env`; backup manifests and scripts never write connection strings, bucket credentials, or environment files.

## Backups and isolated restore checks

The local backup helper contains a PostgreSQL custom-format dump and a tar archive of an explicitly supplied local file-storage directory. It is for the local adapter and isolated tests only; it does not contact or export a Railway Bucket. The PostgreSQL dump includes the file object metadata and revision relationships. For a production recovery set, pair the dump with a separately exported bucket object set using the private bucket's S3-compatible endpoint and keep the object export's manifest beside the dump. Import objects into a fresh bucket before restoring application traffic, then restore Postgres and reconcile object metadata. Pass both local paths explicitly; the scripts reject `/`, the current home directory, repository roots, `reference-project`, and `context` targets.

```bash
DATABASE_URL='postgresql://…' ./scripts/backup.sh /absolute/path/to/backups /absolute/path/to/local-files
```

The command creates a timestamped directory under the backup root. Restore into a fresh local database and an empty file-storage directory first:

```bash
createdb richtfest_restore_check
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/richtfest_restore_check' \
  ./scripts/restore.sh /absolute/path/to/backups/richtfest-YYYYMMDDTHHMMSSZ \
  /absolute/path/to/restore-files
```

Use `--clean-db` only when intentionally restoring into an existing disposable database. Use `--replace-files` only when the target file directory is disposable; the script moves the previous directory aside before installing the restored copy. Inspect the restored row and file counts, then remove the isolated database and temporary files yourself. Do not point restore commands at `reference-project/` or customer originals.

Preparing this configuration does not deploy or provision Railway. Deployment remains an explicit operator action after reviewing the staged diff and running the relevant checks.
