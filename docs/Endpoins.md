# API Endpoints Map

Base URL: `http://localhost:3000`

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{ status: "ok" }` — liveness check |

---

## WebDAV — `/webdav`

Crawls the DMSF WebDAV server and persists metadata to the database.

| Method | Path | Query Params | Description |
|--------|------|--------------|-------------|
| `POST` | `/webdav/scan` | `path` *(optional)* | Recursively scans the WebDAV path (defaults to `WEBDAV_ROOT_PATH`) and upserts `Folder` + `Document` rows. Returns scan summary. |
| `GET` | `/webdav/documents` | — | Lists all `Document` rows in the DB. |
| `GET` | `/webdav/folders` | — | Lists all `Folder` rows in the DB. |
| `GET` | `/webdav/folders-with-documents` | — | Lists all folders with their nested documents joined. |

### POST /webdav/scan — Response
```json
{
  "traceId": "uuid",
  "scannedPath": "/dmsf/webdav/...",
  "foldersUpserted": 12,
  "documentsUpserted": 48,
  "errors": []
}
```

---

## Sync — `/sync`

Bootstraps the Google Drive folder hierarchy and enqueues file upload jobs via BullMQ.  
**Prerequisite:** run `POST /webdav/scan` first to populate the DB.

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `POST` | `/sync/start` | `path` *(optional query)* | Starts a sync job scoped to documents whose `webdavPath` starts with `path`. Without `path`, syncs all documents. Returns `syncJobId` immediately (async). |
| `GET` | `/sync/jobs` | — | Lists the 20 most recent `SyncJob` rows ordered by `startedAt` desc. |
| `GET` | `/sync/jobs/:id` | `id` *(route)* | Returns a single `SyncJob` by ID. `404` if not found. |

### POST /sync/start — Response
```json
{
  "syncJobId": "uuid",
  "message": "Sync job started",
  "scope": "/dmsf/webdav/... or all documents"
}
```

### GET /sync/jobs/:id — Response
```json
{
  "id": "uuid",
  "status": "DONE",
  "traceId": "uuid",
  "startedAt": "2026-05-13T02:00:00.000Z",
  "completedAt": "2026-05-13T02:05:31.000Z",
  "filesProcessed": 42,
  "filesSkipped": 6,
  "filesFailed": 0,
  "error": null
}
```

**SyncJob status lifecycle:** `PENDING → RUNNING → DONE | FAILED`

> On `DONE`, the AI export is automatically generated (written to `AI_EXPORT_PATH` and uploaded to GDrive).

---

## Indexing — `/indexing`

Queries the DB and generates structured JSON exports for AI ingestion pipelines.

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/indexing/documents` | `path` *(optional query)* | Lists `Document` rows filtered by `webdavPath` prefix. |
| `GET` | `/indexing/folders` | `path` *(optional query)* | Lists `Folder` rows filtered by `webdavPath` prefix. |
| `GET` | `/indexing/export` | `path` *(optional query)* | Inline JSON export (folders + documents) scoped by path. **Does not write to disk or GDrive.** |
| `POST` | `/indexing/export/:syncJobId` | `syncJobId` *(route)* | Triggers full AI export for a `SyncJob`: writes `{syncJobId}.json` to `AI_EXPORT_PATH` and uploads manifest to GDrive root folder. |

### GET /indexing/documents — Response
```json
{
  "total": 48,
  "path": "/dmsf/webdav/...",
  "documents": [ { "id": "...", "name": "spec.pdf", "webdavPath": "...", ... } ]
}
```

### GET /indexing/export — Response
```json
{
  "exportedAt": "2026-05-13T10:00:00.000Z",
  "path": "/dmsf/webdav/...",
  "folderCount": 12,
  "documentCount": 48,
  "folders": [
    { "id": "...", "name": "Requirements", "webdavPath": "...", "googleDriveFolderId": "...", "parentId": null }
  ],
  "documents": [
    {
      "id": "...",
      "name": "spec.pdf",
      "webdavPath": "/dmsf/webdav/.../spec.pdf",
      "mimeType": "application/pdf",
      "size": "204800",
      "checksum": "sha256hex",
      "googleDriveFileId": "1abc...",
      "syncedAt": "2026-05-13T02:05:00.000Z",
      "lastModified": "2026-04-01T00:00:00.000Z",
      "folder": "/dmsf/webdav/..."
    }
  ]
}
```

### POST /indexing/export/:syncJobId — Response
```json
{
  "syncJobId": "uuid",
  "traceId": "uuid",
  "message": "Export generation triggered"
}
```

---

## Typical Workflow

```
1. POST /webdav/scan                      — crawl WebDAV, populate DB
2. POST /sync/start                       — bootstrap GDrive folders, enqueue uploads
3. GET  /sync/jobs/:id                    — poll until status = DONE
4.      (AI export auto-triggered on DONE)
   POST /indexing/export/:syncJobId       — or re-trigger manually
5. GET  /indexing/export?path=...         — inspect export inline at any time
```