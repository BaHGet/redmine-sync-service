import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../shared/prisma.service';
import { GdriveService } from '../gdrive/gdrive.service';

interface FolderNode {
  id: string;
  name: string;
  webdavPath: string;
  googleDriveFolderId: string | null;
  children: FolderNode[];
}

interface DocumentExport {
  name: string;
  webdavPath: string;
  googleDriveFileId: string | null;
  mimeType: string;
  size: string;
  checksum: string;
  lastModified: string;
}

interface AiExport {
  syncJobId: string;
  exportedAt: string;
  project: string;
  folders: FolderNode[];
  documents: DocumentExport[];
}

@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gdrive: GdriveService,
    private readonly config: ConfigService,
  ) {}

  async generateExport(syncJobId: string, traceId: string): Promise<void> {
    this.logger.log({ traceId, syncJobId }, 'Generating AI export');

    // ── 1. Load SyncJob ────────────────────────────────────────────────────
    let syncJob: Awaited<ReturnType<typeof this.prisma.syncJob.findUnique>>;
    try {
      syncJob = await this.prisma.syncJob.findUnique({
        where: { id: syncJobId },
      });
    } catch (err: any) {
      this.logger.error(
        { traceId, syncJobId, err: err.message },
        'DB error loading SyncJob — aborting export',
      );
      return;
    }

    if (!syncJob) {
      this.logger.warn(
        { traceId, syncJobId },
        'SyncJob not found — skipping export',
      );
      return;
    }

    // ── 2. Load all folders and documents ─────────────────────────────────
    let folders: Awaited<ReturnType<typeof this.prisma.folder.findMany>>;
    let documents: Awaited<
      ReturnType<
        typeof this.prisma.document.findMany<{
          include: { parentFolder: true };
        }>
      >
    >;

    try {
      [folders, documents] = await Promise.all([
        this.prisma.folder.findMany(),
        this.prisma.document.findMany({ include: { parentFolder: true } }),
      ]);
      this.logger.log(
        {
          traceId,
          syncJobId,
          folderCount: folders.length,
          documentCount: documents.length,
        },
        'Loaded folders and documents from DB',
      );
    } catch (err: any) {
      this.logger.error(
        { traceId, syncJobId, err: err.message },
        'DB error loading folders/documents — aborting export',
      );
      return;
    }

    // ── 3. Build hierarchical folder tree ─────────────────────────────────
    let rootFolders: FolderNode[];
    try {
      const folderMap = new Map<string, FolderNode>(
        folders.map((f) => [
          f.id,
          {
            id: f.id,
            name: f.name,
            webdavPath: f.webdavPath,
            googleDriveFolderId: f.googleDriveFolderId,
            children: [],
          },
        ]),
      );

      rootFolders = [];
      for (const f of folders) {
        const node = folderMap.get(f.id)!;
        if (f.parentId && folderMap.has(f.parentId)) {
          folderMap.get(f.parentId)!.children.push(node);
        } else {
          rootFolders.push(node);
        }
      }

      this.logger.debug(
        { traceId, syncJobId, rootFolderCount: rootFolders.length },
        'Folder tree built',
      );
    } catch (err: any) {
      this.logger.error(
        { traceId, syncJobId, err: err.message },
        'Failed to build folder tree — aborting export',
      );
      return;
    }

    // ── 4. Build document list ─────────────────────────────────────────────
    let docExports: DocumentExport[];
    try {
      docExports = documents.map((d) => ({
        name: d.name,
        webdavPath: d.webdavPath,
        googleDriveFileId: d.googleDriveFileId,
        mimeType: d.mimeType,
        size: d.size.toString(),
        checksum: d.checksum,
        lastModified: d.lastModified.toISOString(),
      }));
    } catch (err: any) {
      this.logger.error(
        { traceId, syncJobId, err: err.message },
        'Failed to map documents for export — aborting export',
      );
      return;
    }

    // ── 5. Assemble & serialize payload ───────────────────────────────────
    const webdavRootPath: string =
      this.config.get<string>('WEBDAV_ROOT_PATH') ?? '';
    const project =
      webdavRootPath.split('/').filter(Boolean).pop() ?? 'redmine';

    const exportPayload: AiExport = {
      syncJobId,
      exportedAt: new Date().toISOString(),
      project,
      folders: rootFolders,
      documents: docExports,
    };

    let json: string;
    try {
      json = JSON.stringify(exportPayload, null, 2);
    } catch (err: any) {
      this.logger.error(
        { traceId, syncJobId, err: err.message },
        'JSON serialization failed — aborting export',
      );
      return;
    }

    // ── 6. Write to AI_EXPORT_PATH ─────────────────────────────────────────
    const exportDir: string =
      this.config.get<string>('AI_EXPORT_PATH') ?? '/app/exports';
    const filePath = path.join(exportDir, `${syncJobId}.json`);

    try {
      await fs.promises.mkdir(exportDir, { recursive: true });
      await fs.promises.writeFile(filePath, json, 'utf8');
      this.logger.log(
        {
          traceId,
          syncJobId,
          filePath,
          sizeBytes: Buffer.byteLength(json, 'utf8'),
        },
        'AI export written to disk',
      );
    } catch (err: any) {
      this.logger.error(
        { traceId, syncJobId, filePath, err: err.message, code: err.code },
        'Failed to write AI export to disk — GDrive upload will still be attempted',
      );
    }

    // ── 7. Upload manifest to GDrive root folder ───────────────────────────
    try {
      const jsonBuffer = Buffer.from(json, 'utf8');
      const readable = Readable.from(jsonBuffer);
      const manifestName = `export_${syncJobId}.json`;
      const rootFolderId = this.gdrive.getRootFolderId();

      this.logger.debug(
        { traceId, syncJobId, manifestName, rootFolderId },
        'Uploading AI export manifest to GDrive',
      );

      const fileId = await this.gdrive.uploadFile(
        manifestName,
        'application/json',
        rootFolderId,
        readable,
      );

      this.logger.log(
        { traceId, syncJobId, gdriveFileId: fileId, manifestName },
        'AI export manifest uploaded to GDrive',
      );
    } catch (err: any) {
      this.logger.warn(
        { traceId, syncJobId, err: err.message },
        'Failed to upload AI export manifest to GDrive — local copy still available',
      );
    }

    this.logger.log({ traceId, syncJobId }, 'AI export generation complete');
  }

  /**
   * Returns documents from the DB, optionally filtered by webdavPath prefix.
   */
  async queryDocuments(pathPrefix?: string) {
    const where = pathPrefix ? { webdavPath: { startsWith: pathPrefix } } : {};
    try {
      const docs = await this.prisma.document.findMany({
        where,
        include: { parentFolder: true },
        orderBy: { webdavPath: 'asc' },
      });
      this.logger.debug(
        { pathPrefix, count: docs.length },
        'queryDocuments result',
      );
      return docs;
    } catch (err: any) {
      this.logger.error(
        { pathPrefix, err: err.message },
        'DB error in queryDocuments',
      );
      throw err;
    }
  }

  /**
   * Returns folders from the DB, optionally filtered by webdavPath prefix.
   */
  async queryFolders(pathPrefix?: string) {
    const where = pathPrefix ? { webdavPath: { startsWith: pathPrefix } } : {};
    try {
      const folders = await this.prisma.folder.findMany({
        where,
        include: { children: false },
        orderBy: { webdavPath: 'asc' },
      });
      this.logger.debug(
        { pathPrefix, count: folders.length },
        'queryFolders result',
      );
      return folders;
    } catch (err: any) {
      this.logger.error(
        { pathPrefix, err: err.message },
        'DB error in queryFolders',
      );
      throw err;
    }
  }
}
