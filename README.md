# Redmine Sync Service

A NestJS service that crawls a Redmine DMSF WebDAV server, mirrors the folder/document hierarchy to Google Drive, and produces structured JSON exports for AI ingestion pipelines.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Environment Variables](#environment-variables)
- [Running with Docker](#running-with-docker)
- [Running Locally](#running-locally)
- [API Endpoints](#api-endpoints)
- [Typical Workflow](#typical-workflow)
- [Project Structure](#project-structure)
- [Further Documentation](#further-documentation)

---

## Overview

| Capability            | Description                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| **WebDAV Scan**       | Recursively crawls Redmine DMSF WebDAV and upserts `Folder` + `Document` metadata to PostgreSQL                              |
| **Google Drive Sync** | Mirrors folder hierarchy and uploads documents (`.pdf`, `.doc`, `.docx`, `.xlsx`) to a Shared Drive via a service account    |
| **AI Export**         | Generates structured JSON manifests (folders + documents) written to disk and uploaded to GDrive for downstream AI pipelines |
| **Job Queue**         | BullMQ + Redis for async sync jobs with status tracking (`PENDING → RUNNING → DONE                                           | FAILED`) |
| **Scheduled Sync**    | Optional cron-based automatic syncing via `@nestjs/schedule`                                                                 |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        NestJS Application                        │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────────┐   │
│  │  /webdav   │  │   /sync    │  │       /indexing         │   │
│  │ Controller │  │ Controller │  │      Controller         │   │
│  └─────┬──────┘  └─────┬──────┘  └────────────┬────────────┘   │
│  ┌─────▼──────┐  ┌─────▼──────┐  ┌────────────▼────────────┐   │
│  │  Webdav    │  │    Sync    │  │     Indexing            │   │
│  │  Service   │  │  Service   │  │     Service             │   │
│  └─────┬──────┘  └─────┬──────┘  └────────────┬────────────┘   │
│        │         ┌─────▼──────┐                │                │
│        │         │    Sync    │ (BullMQ worker) │                │
│        │         │ Processor  │                │                │
│        │         └─────┬──────┘                │                │
│  ┌─────▼───────────────▼───────────────────────▼────────────┐   │
│  │            PrismaService · GdriveService                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────┐  ┌─────────────┐  ┌──────────────────┐   │
│  │    PostgreSQL     │  │    Redis    │  │   Google Drive   │   │
│  │   (Prisma ORM)   │  │  (BullMQ)  │  │  Service Account │   │
│  └──────────────────┘  └─────────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- **Docker** + **Docker Compose** (recommended)
- **Node.js 22** (local development only)
- A **Google Cloud project** with Drive API enabled and a service account JSON key
- Access to a **Redmine** instance with DMSF WebDAV enabled

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Google Cloud service account

1. Enable the **Google Drive API** in your Google Cloud project
2. Create a **Service Account** and download the JSON key
3. Create a **Shared Drive** in Google Drive and add the service account as **Content Manager**
4. Copy the Shared Drive ID from the browser URL
5. Stringify the service account JSON:
   ```bash
   cat your-service-account.json | tr -d '\n'
   ```

### 3. Create the environment file

```bash
cp .env.example .env
# Edit .env with your values
```

---

## Environment Variables

| Variable                      | Description                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV`                    | `development` or `production`                                          |
| `PORT`                        | API port (default `3000`)                                              |
| `LOG_LEVEL`                   | `trace` / `debug` / `info` / `warn` / `error`                          |
| `REDMINE_URL`                 | Base URL of your Redmine instance                                      |
| `REDMINE_API_KEY`             | Redmine API key (Profile → API access key)                             |
| `WEBDAV_URL`                  | Redmine DMSF WebDAV URL                                                |
| `WEBDAV_USERNAME`             | Redmine login username                                                 |
| `WEBDAV_PASSWORD`             | Redmine login password                                                 |
| `WEBDAV_ROOT_PATH`            | Default scan path (e.g. `/[documents-repository]/`)                    |
| `GDRIVE_ROOT_FOLDER_ID`       | Shared Drive ID                                                        |
| `GDRIVE_SERVICE_ACCOUNT_JSON` | Service account JSON key, stringified to one line                      |
| `POSTGRES_USER`               | DB username                                                            |
| `POSTGRES_PASSWORD`           | DB password                                                            |
| `POSTGRES_DB`                 | DB name                                                                |
| `DATABASE_URL`                | Full Postgres connection string (use `postgres` as host inside Docker) |
| `REDIS_HOST`                  | Redis hostname (use `redis` inside Docker)                             |
| `REDIS_PORT`                  | Redis port (default `6379`)                                            |
| `AI_EXPORT_PATH`              | Container path for JSON exports (default `/app/exports`)               |

---

## Running with Docker

```bash
# Start all services (app, postgres, redis)
docker compose up --build

# Run in background
docker compose up -d --build
```

The API will be available at `http://localhost:3000`.

---

## Running Locally

```bash
# Apply database migrations
npx prisma migrate deploy

# Development (watch mode)
npm run start:dev

# Production build
npm run build && npm run start:prod
```

---

## API Endpoints

Base URL: `http://localhost:3000`

### Health

| Method | Path      | Description                |
| ------ | --------- | -------------------------- |
| `GET`  | `/health` | Returns `{ status: "ok" }` |

### WebDAV — `/webdav`

| Method | Path                             | Description                                                 |
| ------ | -------------------------------- | ----------------------------------------------------------- |
| `POST` | `/webdav/scan`                   | Recursively scans WebDAV and upserts Folder + Document rows |
| `GET`  | `/webdav/documents`              | Lists all Document rows                                     |
| `GET`  | `/webdav/folders`                | Lists all Folder rows                                       |
| `GET`  | `/webdav/folders-with-documents` | Lists folders with nested documents                         |

### Sync — `/sync`

| Method | Path             | Description                                               |
| ------ | ---------------- | --------------------------------------------------------- |
| `POST` | `/sync/start`    | Starts an async sync job; returns `syncJobId` immediately |
| `GET`  | `/sync/jobs`     | Lists the 20 most recent sync jobs                        |
| `GET`  | `/sync/jobs/:id` | Returns a single sync job by ID                           |

**SyncJob status lifecycle:** `PENDING → RUNNING → DONE | FAILED`

> After a job reaches `DONE`, the AI export is automatically generated and uploaded to GDrive.

### Indexing — `/indexing`

| Method | Path                          | Description                                                         |
| ------ | ----------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/indexing/documents`         | Lists documents, optionally filtered by `path` query param          |
| `GET`  | `/indexing/folders`           | Lists folders, optionally filtered by `path` query param            |
| `GET`  | `/indexing/export`            | Returns inline JSON export (no disk write)                          |
| `POST` | `/indexing/export/:syncJobId` | Writes `{syncJobId}.json` to `AI_EXPORT_PATH` and uploads to GDrive |

---

## Typical Workflow

```
1. POST /webdav/scan          → crawl WebDAV, populate DB
2. POST /sync/start           → mirror to Google Drive (async)
3. GET  /sync/jobs/:id        → poll until status is DONE
4. GET  /indexing/export      → retrieve AI-ready JSON manifest
```

---

## Project Structure

```
src/
├── modules/
│   ├── config/       # Env schema validation (Zod)
│   ├── gdrive/       # Google Drive upload service
│   ├── indexing/     # AI export generation
│   ├── logger/       # Pino logger setup
│   ├── redmine/      # Redmine API client
│   ├── scheduler/    # Cron-based auto-sync
│   ├── sync/         # BullMQ sync jobs & processor
│   └── webdav/       # WebDAV crawler
├── shared/
│   ├── prisma.service.ts
│   └── path.utils.ts
prisma/
└── schema.prisma     # PostgreSQL schema (Folder, Document, SyncJob)
docs/
├── DESIGN_SCHEMA.md  # Architecture & DB schema reference
├── Endpoins.md       # Full API reference
├── SETUP.md          # Detailed setup guide
└── Runbook.md        # Operational runbook
```

---

## Further Documentation

- [Design & Schema Reference](docs/DESIGN_SCHEMA.md)
- [API Endpoints](docs/Endpoins.md)
- [Setup Guide](docs/SETUP.md)
- [Runbook](docs/Runbook.md)
