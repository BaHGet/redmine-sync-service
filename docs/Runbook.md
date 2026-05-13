# Redmine Sync Service — Operations Runbook

---

## 1. Daily Operations

### Start the stack
```bash
docker compose up -d
docker compose logs -f api
```

### Stop the stack
```bash
docker compose down
```

### Rebuild after code changes
```bash
docker compose up -d --build api
```

---

## 2. Running a Sync

### Full sync (all documents in DB)
```bash
curl -X POST http://localhost:3000/webdav/scan
curl -X POST http://localhost:3000/sync/start
```

### Scoped sync (specific WebDAV path prefix)
```bash
# Scan only a sub-path first
curl -X POST "http://localhost:3000/webdav/scan?path=/dmsf/webdav/Documents%20Repository/CRM%20Documents"

# Then sync only that sub-path
curl -X POST "http://localhost:3000/sync/start?path=/dmsf/webdav/Documents%20Repository/CRM%20Documents"
```

### Poll job status until DONE
```bash
JOB_ID="<syncJobId from response>"
curl http://localhost:3000/sync/jobs/$JOB_ID
```

Expected final states: `DONE` or `FAILED`.

---

## 3. Diagnosing a Failed Sync Job

### Find recent failed jobs
```bash
curl http://localhost:3000/sync/jobs | jq '.jobs[] | select(.status == "FAILED")'
```

### Check the error message
```bash
curl http://localhost:3000/sync/jobs/<id> | jq '.error'
```

### Check DB directly
```bash
docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
  "SELECT id, status, \"filesProcessed\", \"filesFailed\", error, \"completedAt\" FROM \"SyncJob\" ORDER BY \"startedAt\" DESC LIMIT 10;"
```

### Find jobs stuck in RUNNING (e.g. after a crash)
```bash
docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
  "SELECT id, \"traceId\", \"startedAt\" FROM \"SyncJob\" WHERE status = 'RUNNING' AND \"startedAt\" < NOW() - INTERVAL '1 hour';"
```

Manually mark a stuck job as FAILED:
```bash
docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
  "UPDATE \"SyncJob\" SET status = 'FAILED', \"completedAt\" = NOW(), error = 'Manually marked failed — process crashed' WHERE id = '<id>';"
```

---

## 4. Re-triggering a Sync / Export

### Re-run sync for a path (re-scans + re-syncs)
```bash
curl -X POST "http://localhost:3000/webdav/scan?path=/dmsf/webdav/..."
curl -X POST "http://localhost:3000/sync/start?path=/dmsf/webdav/..."
```

### Re-generate a lost AI export for an existing SyncJob
```bash
curl -X POST http://localhost:3000/indexing/export/<syncJobId>
```
This writes `{syncJobId}.json` to `AI_EXPORT_PATH` and re-uploads to GDrive. Safe to run multiple times.

### Inspect export inline without writing to disk
```bash
curl "http://localhost:3000/indexing/export?path=/dmsf/webdav/..." | jq '.documentCount'
```

---

## 5. Google Drive 429 / Rate Limit Errors

The service has a built-in token bucket (max 8 req/s). If you see `429` in logs:

1. **Check logs** for the error context:
   ```bash
   docker compose logs api | grep 429
   ```

2. **BullMQ will auto-retry** with exponential backoff (up to 5 attempts). Wait for retries to complete — check job status via `/sync/jobs/:id`.

3. If all 5 attempts fail, the job enters the **dead-letter queue** in Redis. Inspect it:
   ```bash
   docker compose exec redis redis-cli
   > KEYS bull:sync-queue:*
   > LRANGE bull:sync-queue:failed 0 -1
   ```

4. To requeue a failed BullMQ job, restart the sync for the affected path:
   ```bash
   curl -X POST "http://localhost:3000/sync/start?path=/dmsf/webdav/..."
   ```
   Documents with `syncedAt` already set will be automatically skipped.

---

## 6. Documents Not Syncing

### Find documents missing `syncedAt` (never successfully uploaded)
```bash
docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
  "SELECT id, name, \"webdavPath\", \"googleDriveFileId\", \"syncedAt\" FROM \"Document\" WHERE \"syncedAt\" IS NULL LIMIT 20;"
```

### Find documents missing a GDrive folder mapping
```bash
docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
  "SELECT id, name, \"webdavPath\" FROM \"Document\" d \
   JOIN \"Folder\" f ON f.id = d.\"parentFolderId\" \
   WHERE f.\"googleDriveFolderId\" IS NULL LIMIT 20;"
```
Fix: re-run `POST /sync/start` — folder bootstrap re-runs every time.

### Force re-sync of a document (clear syncedAt)
```bash
docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
  "UPDATE \"Document\" SET \"syncedAt\" = NULL, \"googleDriveFileId\" = NULL WHERE \"webdavPath\" = '/dmsf/webdav/.../file.pdf';"
```
Then re-run `POST /sync/start`.

---

## 7. Database Migrations

### Apply pending migrations (runs automatically on `docker compose up`)
```bash
docker compose exec api npx prisma migrate deploy
```

### Create a new migration (development only)
```bash
# Edit prisma/schema.prisma first, then:
docker compose exec api npx prisma migrate dev --name describe_change
```

### Reset DB (⚠️ destroys all data)
```bash
docker compose exec api npx prisma migrate reset
```

---

## 8. Viewing Logs

```bash
# Stream all API logs
docker compose logs -f api

# Filter for a specific traceId
docker compose logs api | grep '"traceId":"<uuid>"'

# Filter for errors only
docker compose logs api | grep '"level":50'   # Pino level 50 = error

# Filter for a specific file being uploaded
docker compose logs api | grep 'spec.pdf'
```

---

## 9. Checking Service Health

```bash
curl http://localhost:3000/health
# → { "status": "ok" }

# Check all containers are up
docker compose ps

# Check Redis is accepting connections
docker compose exec redis redis-cli ping
# → PONG

# Check Postgres is accepting connections
docker compose exec postgres pg_isready
# → /var/run/postgresql:5432 - accepting connections
```

---

## 10. AI Export Files

Export files are written to the `AI_EXPORT_PATH` volume (default `/app/exports` inside the container).

```bash
# List all exports
docker compose exec api ls -lh /app/exports/

# View a specific export
docker compose exec api cat /app/exports/<syncJobId>.json | jq '.documentCount'

# Copy an export to the host
docker compose cp api:/app/exports/<syncJobId>.json ./export.json
```

---