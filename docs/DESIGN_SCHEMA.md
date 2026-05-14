# Design & Schema Reference

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│                        NestJS Application                      │
│                                                                │
│  HTTP Layer                                                    │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────────┐   │
│  │  /webdav   │  │   /sync    │  │       /indexing         │   │
│  │ Controller │  │ Controller │  │      Controller         │   │
│  └─────┬──────┘  └─────┬──────┘  └────────────┬────────────┘   │
│        │               │                       │               │
│  Service Layer         │                       │               │
│  ┌─────▼──────┐  ┌─────▼──────┐  ┌────────────▼────────────┐   │
│  │  Webdav    │  │    Sync    │  │     Indexing            │   │
│  │  Service   │  │  Service   │  │     Service             │   │
│  └─────┬──────┘  └─────┬──────┘  └────────────┬────────────┘   │
│        │               │                       │               │
│        │         ┌─────▼──────┐                │               │
│        │         │    Sync    │                │               │
│        │         │ Processor  │ (BullMQ worker)│               │
│        │         └─────┬──────┘                │               │
│        │               │                       │               │
│  ┌─────▼───────────────▼───────────────────────▼────────────┐  │
│  │                   Shared Services                        │  │
│  │         PrismaService · GdriveService                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────┐  ┌─────────────┐  ┌──────────────────┐   │
│  │    PostgreSQL    │  │    Redis    │  │   Google Drive   │   │
│  │   (Prisma ORM)   │  │  (BullMQ)   │  │  Service Account │   │
│  └──────────────────┘  └─────────────┘  └──────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### `Folder`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `String` (UUID) | PK | Auto-generated UUID |
| `name` | `String` | — | Folder display name |
| `webdavPath` | `String` | UNIQUE | Full WebDAV path (source of truth) |
| `googleDriveFolderId` | `String?` | nullable | GDrive folder ID after sync |
| `parentId` | `String?` | FK → `Folder.id`, nullable | Self-relation for hierarchy |
| `createdAt` | `DateTime` | default now | |
| `updatedAt` | `DateTime` | auto | |

**Relations:** `parent` (self), `children[]` (self), `documents[]` → `Document`

---

### `Document`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `String` (UUID) | PK | Auto-generated UUID |
| `name` | `String` | — | File name with extension |
| `extension` | `String` | — | e.g. `.pdf`, `.docx` |
| `mimeType` | `String` | — | MIME type |
| `webdavPath` | `String` | UNIQUE, VARCHAR(1024), INDEX | Full WebDAV file path |
| `googleDriveFileId` | `String?` | nullable | GDrive file ID after upload |
| `checksum` | `String` | — | SHA-256 of file content |
| `size` | `BigInt` | — | File size in bytes |
| `lastModified` | `DateTime` | — | Last modified timestamp from WebDAV |
| `syncedAt` | `DateTime?` | nullable | Set only after GDrive confirms success |
| `parentFolderId` | `String` | FK → `Folder.id` | Parent folder |
| `createdAt` | `DateTime` | default now | |
| `updatedAt` | `DateTime` | auto | |

**Allowed file extensions:** `.pdf`, `.doc`, `.docx`, `.xlsx`

---

### `SyncJob`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `String` (UUID) | PK | Auto-generated UUID |
| `status` | `SyncJobStatus` | default `PENDING` | Job lifecycle state |
| `traceId` | `String` (UUID) | UNIQUE | Attached to all log entries for this job |
| `startedAt` | `DateTime` | default now | |
| `completedAt` | `DateTime?` | nullable | Set when job reaches DONE or FAILED |
| `filesProcessed` | `Int` | default 0 | Upload jobs enqueued |
| `filesSkipped` | `Int` | default 0 | Already synced (checksum match) |
| `filesFailed` | `Int` | default 0 | Could not be enqueued or folder missing |
| `error` | `String?` | nullable | Error message if status = FAILED |
| `createdAt` | `DateTime` | default now | |
| `updatedAt` | `DateTime` | auto | |

**`SyncJobStatus` enum:** `PENDING` · `RUNNING` · `DONE` · `FAILED`

---

## Module Dependency Graph

```
AppModule
├── ConfigModule        (global — Zod-validated env)
├── LoggerModule        (global — Pino JSON logging)
├── PrismaModule        (global — PostgreSQL via pg adapter)
├── BullModule          (global — Redis connection)
├── ScheduleModule      (global — NestJS cron)
│
├── WebdavModule
│   └── WebdavService   (scans WebDAV, upserts Folder/Document)
│
├── GdriveModule
│   └── GdriveService   (Service Account auth, folder/file management, token bucket)
│
├── SyncModule
│   ├── SyncService     (orchestrates GDrive bootstrap + BullMQ enqueue)
│   ├── SyncProcessor   (BullMQ worker: streams WebDAV → GDrive)
│   └── imports GdriveModule, IndexingModule
│
├── IndexingModule
│   ├── IndexingService (DB queries, JSON export generation)
│   └── imports GdriveModule
│
└── SchedulerModule
    └── SchedulerService (Cron 2AM → sync.startSync())
```

---

## Sync Algorithm

```
POST /webdav/scan
  └─► upsertAncestorFolders()      — ensure parent chain in DB
  └─► scanDirectory() recursive    — collect folders + files (streaming)
  └─► persistScanResult()          — upsert Folder rows (depth-first), then Document rows
      - skips non-allowed extensions
      - skips files with no parent folder in DB

POST /sync/start
  └─► Create SyncJob (RUNNING)
  └─► Fetch documents from DB (optionally prefix-filtered)
  └─► Build full ancestor path set for all parent folders
  └─► gdrive.ensureFolder() for each path (shallow-first)
      - persists googleDriveFolderId back to Folder rows
  └─► For each document:
      - skip if syncedAt + googleDriveFileId already set  → filesSkipped++
      - skip if no GDrive folder mapping                  → filesFailed++
      - enqueue UPLOAD_JOB to BullMQ (5 attempts, exponential backoff)  → filesProcessed++
  └─► Mark SyncJob DONE (or FAILED)
  └─► indexing.generateExport()    — auto-triggered on DONE

BullMQ SyncProcessor (concurrency = 3)
  └─► webdav.createReadStream(webdavPath)
  └─► gdrive.uploadFile()
  └─► Update Document: { googleDriveFileId, syncedAt }
```

---

## AI Export Schema

Written to `AI_EXPORT_PATH/{syncJobId}.json` and uploaded to GDrive root folder as `export_{syncJobId}.json`.

```json
{
  "syncJobId": "uuid",
  "exportedAt": "ISO-8601",
  "project": "Requirements",
  "folders": [
    {
      "id": "uuid",
      "name": "string",
      "webdavPath": "/dmsf/...",
      "googleDriveFolderId": "string | null",
      "children": [ /* recursive FolderNode */ ]
    }
  ],
  "documents": [
    {
      "name": "spec.pdf",
      "webdavPath": "/dmsf/.../spec.pdf",
      "googleDriveFileId": "string | null",
      "mimeType": "application/pdf",
      "size": "204800",
      "checksum": "sha256hex",
      "lastModified": "ISO-8601"
    }
  ]
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | — | `development` | `development` / `production` / `test` |
| `PORT` | — | `3000` | HTTP port |
| `LOG_LEVEL` | — | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `REDMINE_URL` | ✅ | — | Redmine base URL |
| `REDMINE_API_KEY` | ✅ | — | Redmine API key *(redacted in logs)* |
| `WEBDAV_URL` | ✅ | — | DMSF WebDAV base URL |
| `WEBDAV_USERNAME` | ✅ | — | WebDAV username |
| `WEBDAV_PASSWORD` | ✅ | — | WebDAV password *(redacted in logs)* |
| `WEBDAV_ROOT_PATH` | — | `/dmsf/webdav/Documents Repository/CRM Documents/Requirements CRM/Requirements/Requirements` | Default scan path |
| `GDRIVE_ROOT_FOLDER_ID` | ✅ | — | GDrive folder ID of `redmine_requirements` |
| `GDRIVE_SERVICE_ACCOUNT_JSON` | ✅ | — | Service account JSON string *(redacted in logs)* |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `REDIS_HOST` | — | `redis` | Redis host (Docker service name) |
| `REDIS_PORT` | — | `6379` | Redis port |
| `AI_EXPORT_PATH` | — | `/app/exports` | Directory for AI export JSON files |

---

## Rate Limiting & Retry Policy

| Concern | Configuration |
|---------|---------------|
| GDrive API rate limit | Token bucket: max **8 req/s**, 30s timeout per acquire |
| BullMQ retry | Max **5 attempts**, exponential backoff starting at **2000ms** |
| Completed job cleanup | `removeOnComplete: 100` / `removeOnFail: 50` |
| BullMQ concurrency | **3** parallel upload workers |