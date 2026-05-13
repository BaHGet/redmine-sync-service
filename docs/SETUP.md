# Redmine Sync Service — Setup Guide

## Prerequisites

- Docker + Docker Compose
- Node.js 22 (for local development only)
- A Google Cloud project with Drive API enabled
- Access to the Redmine instance

---

## 1. Google Cloud — Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → select or create a project
2. **APIs & Services** → **Enable APIs** → enable **Google Drive API**
3. **APIs & Services** → **Credentials** → **Create Credentials** → **Service Account**
   - Name it anything (e.g. `redmine-sync-sa`)
   - Skip optional steps → **Done**
4. Click the service account → **Keys** tab → **Add Key** → **JSON**
5. Download the JSON file — you will need its contents for `GDRIVE_SERVICE_ACCOUNT_JSON`

---

## 2. Google Drive — Shared Drive

> **Important:** Service accounts have no personal storage quota. Files **must** be uploaded to a Shared Drive.

1. Open [Google Drive](https://drive.google.com) → **Shared drives** (left sidebar) → **+ New**
2. Name it (e.g. `Redmine Requirements`) → **Create**
3. Right-click the Shared Drive → **Manage members**
4. Add the service account email (e.g. `redmine-sync-sa@your-project.iam.gserviceaccount.com`) as **Content manager**
5. Copy the Shared Drive ID from the browser URL:
   ```
   https://drive.google.com/drive/u/0/folders/THIS_IS_THE_ID
   ```
6. This ID goes into `GDRIVE_ROOT_FOLDER_ID` in `.env`

---

## 3. Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `development` or `production` |
| `PORT` | API port (default `3000`) |
| `LOG_LEVEL` | `trace` / `debug` / `info` / `warn` / `error` |
| `REDMINE_URL` | Base URL of your Redmine instance |
| `REDMINE_API_KEY` | Redmine API key — Profile → API access key |
| `WEBDAV_URL` | Redmine DMSF WebDAV URL (e.g. `https://redmine.example.com/dmsf/webdav`) |
| `WEBDAV_USERNAME` | Redmine login username |
| `WEBDAV_PASSWORD` | Redmine login password |
| `WEBDAV_ROOT_PATH` | Default scan path if none provided (e.g. `/[documents-repository]/`) |
| `GDRIVE_ROOT_FOLDER_ID` | ID of the Shared Drive (step 2.5 above) |
| `GDRIVE_SERVICE_ACCOUNT_JSON` | Full service account JSON key, stringified to one line |
| `POSTGRES_USER` | DB username |
| `POSTGRES_PASSWORD` | DB password |
| `POSTGRES_DB` | DB name |
| `DATABASE_URL` | Full Postgres connection string — use `postgres` as host inside Docker |
| `REDIS_HOST` | Redis hostname — use `redis` inside Docker |
| `REDIS_PORT` | Redis port (default `6379`) |
| `AI_EXPORT_PATH` | Container path for JSON exports (default `/app/exports`) |

### Stringify the service account JSON

```bash
# Linux/macOS:
cat your-service-account.json | tr -d '\n'
```

Paste the output as the value of `GDRIVE_SERVICE_ACCOUNT_JSON` in `.env`.

---

## 4. WebDAV Path Discovery

Redmine DMSF uses bracket-encoded identifiers, not display names.

```
POST http://localhost:3000/webdav/scan?path=/
```

Common pattern: `/[documents-repository]/[project-identifier]/[subfolder-identifier]/`

---

## 5. Start with Docker Compose

```bash
# First time / after code changes:
docker compose up --build -d

# After .env-only changes:
docker compose up -d

# Logs:
docker compose logs -f api

# Stop:
docker compose down
```

API: `http://localhost:3000`. Tables are created automatically on first start via `prisma db push`.

---

## 6. Database Schema Changes

```bash
npx prisma generate
docker compose exec api npx prisma db push
# or rebuild:
docker compose up --build -d
```

---

## 7. API Endpoints

### WebDAV

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/webdav/scan?path=` | Scan path recursively, save to DB. Defaults to `WEBDAV_ROOT_PATH`. |
| `GET` | `/webdav/documents` | All documents in DB |
| `GET` | `/webdav/folders` | All folders in DB |
| `GET` | `/webdav/folders-with-documents` | Folders joined with documents |

### Sync

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sync/start?path=` | Start sync. Optional `path` scopes to subtree. Omit for all. |
| `GET` | `/sync/jobs` | Last 20 sync jobs |
| `GET` | `/sync/jobs/:id` | Single sync job status |

### Typical workflow

```
1. POST /webdav/scan?path=/[documents-repository]/[crm-documents]
2. GET  /webdav/folders-with-documents   ← verify
3. POST /sync/start?path=/[documents-repository]/[crm-documents]/[requirements]
4. GET  /sync/jobs/:id                   ← monitor
```

Paths are percent-encoding safe — both `/[crm]` and `/%5Bcrm%5D` work.

---

## 8. Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `GDrive folder ID not found` | Wrong root folder ID or SA not a member | Check `GDRIVE_ROOT_FOLDER_ID`; add SA to Shared Drive |
| `GDrive permission denied` | SA has no write access | Add SA as **Content manager** on Shared Drive |
| `storageQuotaExceeded` | Uploading to a regular My Drive folder | Use a **Shared Drive** (step 2) |
| `GDrive authentication failed` | Invalid service account JSON | Verify `GDRIVE_SERVICE_ACCOUNT_JSON` is valid one-line JSON |
| `WebDAV path not found` | Wrong bracket path | Scan from `/` to discover correct paths |
| `EAI_AGAIN` / `ETIMEDOUT` | DNS failure inside Docker | Add `dns: [8.8.8.8, 8.8.4.4]` under `api` in `docker-compose.yml` |
| `Cannot serialize BigInt` | Missing BigInt patch | Add `(BigInt.prototype as any).toJSON = function() { return this.toString(); }` in `main.ts` before `bootstrap()` |