import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, WebDAVClient, FileStat } from 'webdav';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { PrismaService } from '../../shared/prisma.service';
import { Folder, Document } from '@prisma/client';
import { normalizePath, sanitizeWebdavPath } from '../../shared/path.utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScannedFile {
  name: string;
  webdavPath: string;
  mimeType: string;
  extension: string;
  size: bigint;
  lastModified: Date;
}

export interface ScannedFolder {
  name: string;
  webdavPath: string;
  parentPath: string | null;
}

export interface ScanResult {
  folders: ScannedFolder[];
  files: ScannedFile[];
}

export interface ScanSummary {
  foldersUpserted: number;
  documentsUpserted: number;
  errors: string[];
}

export type FolderWithDocuments = Folder & { documents: Document[] };

const ALLOWED_EXTENSIONS = new Set([
  // documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.rtf', '.md', '.odt',

  // images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.svg', '.webp', '.heic',

  // archives
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',

  // executables / web packages
  '.exe', '.msi', '.bat', '.sh', '.jar', '.apk', '.html', '.htm', '.web',
]);
const DEFAULT_SCAN_ROOT = '/[documents-repository]/';

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class WebdavService {
  private readonly logger = new Logger(WebdavService.name);
  private readonly client: WebDAVClient;
  private readonly defaultRootPath: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.client = createClient(this.config.get<string>('WEBDAV_URL')!, {
      username: this.config.get<string>('WEBDAV_USERNAME'),
      password: this.config.get<string>('WEBDAV_PASSWORD'),
    });
    this.defaultRootPath =
      this.config.get<string>('WEBDAV_ROOT_PATH') ?? DEFAULT_SCAN_ROOT;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Recursively scans dirPath (defaults to WEBDAV_ROOT_PATH env var),
   * persists all folders and allowed documents to DB, returns a summary.
   */
  async scanAndPersist(
    traceId: string,
    dirPath?: string,
  ): Promise<ScanSummary> {
    const rootPath = normalizePath(dirPath ?? this.defaultRootPath);
    this.logger.log({ traceId, rootPath }, 'Starting WebDAV scan');
    // Before scanning, upsert every ancestor segment of rootPath so the
    // parentId chain is intact and sync places files in the correct GDrive location.
    await this.upsertAncestorFolders(rootPath, traceId);

    const result: ScanResult = { folders: [], files: [] };

    // Push the root dir itself as the top-level folder
    const rootParentPath =
      rootPath.lastIndexOf('/') > 0
        ? rootPath.substring(0, rootPath.lastIndexOf('/'))
        : null;
    result.folders.push({
      name: rootPath.split('/').filter(Boolean).pop() ?? rootPath,
      webdavPath: rootPath,
      parentPath: rootParentPath,
    });

    await this.scanDirectory(rootPath, rootPath, result, traceId);

    this.logger.log(
      { traceId, folders: result.folders.length, files: result.files.length },
      'WebDAV scan complete — persisting to DB',
    );

    return this.persistScanResult(result, traceId);
  }

  /** Returns all documents stored in DB. */
  async listDocuments(): Promise<Document[]> {
    return this.prisma.document.findMany({
      orderBy: { webdavPath: 'asc' },
    });
  }

  /** Returns all folders stored in DB. */
  async listFolders(): Promise<Folder[]> {
    return this.prisma.folder.findMany({
      orderBy: { webdavPath: 'asc' },
    });
  }

  /** Returns all folders with their documents. */
  async listFoldersWithDocuments(): Promise<FolderWithDocuments[]> {
    return this.prisma.folder.findMany({
      include: { documents: true },
      orderBy: { webdavPath: 'asc' },
    }) as Promise<FolderWithDocuments[]>;
  }

  // ── Internal scan ──────────────────────────────────────────────────────────

  private async scanDirectory(
    dirPath: string,
    parentPath: string | null,
    result: ScanResult,
    traceId: string,
  ): Promise<void> {
    let contents: FileStat[];
    try {
      // Use encodeURI instead of per-segment encoding because some WebDAV
      // servers reject certain percent-encodings (e.g. brackets/apostrophes).
      const requestPath = encodeURI(dirPath);
      this.logger.debug(
        { traceId, dirPath, requestPath },
        'Requesting WebDAV directory',
      );
      contents = (await this.client.getDirectoryContents(dirPath)) as FileStat[];
    } catch (err: any) {
      const status: number | undefined = err?.status ?? err?.response?.status;
      const errText = err?.message ?? String(err);
      if (status === 401 || status === 403) {
        this.logger.error(
          { traceId, dirPath, status, err: errText },
          'WebDAV auth failed — check WEBDAV_USERNAME / WEBDAV_PASSWORD',
        );
      } else if (status === 404) {
        this.logger.error(
          { traceId, dirPath, status, err: errText },
          'WebDAV path not found — check the supplied path',
        );
      } else {
        this.logger.error(
          { traceId, dirPath, status, err: errText },
          'Failed to list WebDAV directory',
        );
      }
      return;
    }

    for (const item of contents) {
      const safePath = this.sanitizePath(item.filename);
      if (!safePath) continue;

      if (item.type === 'directory') {
        result.folders.push({
          name: item.basename,
          webdavPath: safePath,
          parentPath,
        });
        this.logger.debug({ traceId, path: safePath }, 'Found folder');
        await this.scanDirectory(safePath, safePath, result, traceId);
      } else if (item.type === 'file') {
        const ext = this.getExtension(item.basename);
        if (!ALLOWED_EXTENSIONS.has(ext)) continue;

        result.files.push({
          name: item.basename,
          webdavPath: safePath,
          mimeType: item.mime ?? 'application/octet-stream',
          extension: ext,
          size: BigInt(item.size ?? 0),
          lastModified: new Date(item.lastmod),
        });
        this.logger.debug({ traceId, path: safePath }, 'Found file');
      }
    }
  }

  // ── DB persistence ─────────────────────────────────────────────────────────

  private async persistScanResult(
    result: ScanResult,
    traceId: string,
  ): Promise<ScanSummary> {
    const errors: string[] = [];
    let foldersUpserted = 0;
    let documentsUpserted = 0;

    // Folders are depth-first from scanDirectory — parents always appear before children
    const folderIdMap = new Map<string, string>(); // webdavPath → DB id

    for (const f of result.folders) {
      try {
        // Prefer already-mapped parent (from this scan), fall back to DB lookup
        let parentDbId: string | null = null;
        if (f.parentPath) {
          parentDbId =
            folderIdMap.get(f.parentPath) ??
            (
              await this.prisma.folder
                .findUnique({ where: { webdavPath: f.parentPath } })
                .catch(() => null)
            )?.id ??
            null;
        }

        const record = await this.prisma.folder.upsert({
          where: { webdavPath: f.webdavPath },
          update: { name: f.name, parentId: parentDbId },
          create: {
            name: f.name,
            webdavPath: f.webdavPath,
            parentId: parentDbId,
          },
        });

        folderIdMap.set(f.webdavPath, record.id);
        foldersUpserted++;
        this.logger.debug(
          { traceId, path: f.webdavPath, id: record.id },
          'Folder upserted',
        );
      } catch (err: any) {
        this.logger.error(
          { traceId, path: f.webdavPath, err: err.message },
          'Failed to upsert folder',
        );
        errors.push(`folder ${f.webdavPath}: ${err.message}`);
      }
    }

    for (const file of result.files) {
      try {
        const parentDir = file.webdavPath.substring(
          0,
          file.webdavPath.lastIndexOf('/'),
        );

        let parentFolderId =
          folderIdMap.get(parentDir) ??
          (
            await this.prisma.folder
              .findUnique({ where: { webdavPath: parentDir } })
              .catch(() => null)
          )?.id;

        if (!parentFolderId) {
          this.logger.warn(
            { traceId, path: file.webdavPath, parentDir },
            'No parent folder found for file — skipping',
          );
          errors.push(
            `doc ${file.webdavPath}: parent folder '${parentDir}' not in DB`,
          );
          continue;
        }

        await this.prisma.document.upsert({
          where: { webdavPath: file.webdavPath },
          update: {
            name: file.name,
            mimeType: file.mimeType,
            extension: file.extension,
            size: file.size,
            lastModified: file.lastModified,
          },
          create: {
            name: file.name,
            webdavPath: file.webdavPath,
            extension: file.extension,
            mimeType: file.mimeType,
            checksum: '',
            size: file.size,
            lastModified: file.lastModified,
            parentFolderId,
          },
        });

        documentsUpserted++;
        this.logger.debug(
          { traceId, path: file.webdavPath },
          'Document upserted',
        );
      } catch (err: any) {
        this.logger.error(
          { traceId, path: file.webdavPath, err: err.message },
          'Failed to upsert document',
        );
        errors.push(`doc ${file.webdavPath}: ${err.message}`);
      }
    }

    this.logger.log(
      {
        traceId,
        foldersUpserted,
        documentsUpserted,
        errorCount: errors.length,
      },
      'Scan persistence complete',
    );
    return { foldersUpserted, documentsUpserted, errors };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private sanitizePath(rawPath: string): string | null {
    return sanitizeWebdavPath(rawPath);
  }

  /**
   * Upserts every path segment of fullPath as a Folder row, linking each to
   * its parent. Ensures the parentId chain is intact so sync can build the
   * correct GDrive hierarchy even when scanning a sub-path.
   */
  private async upsertAncestorFolders(
    fullPath: string,
    traceId: string,
  ): Promise<void> {
    const segments = fullPath.split('/').filter(Boolean);
    if (segments.length === 0) return;

    const idMap = new Map<string, string>(); // path → DB id

    for (let i = 0; i < segments.length; i++) {
      const path = '/' + segments.slice(0, i + 1).join('/');
      const parentPath = i === 0 ? null : '/' + segments.slice(0, i).join('/');
      const parentId = parentPath ? (idMap.get(parentPath) ?? null) : null;

      try {
        const record = await this.prisma.folder.upsert({
          where: { webdavPath: path },
          update: { parentId: parentId ?? undefined },
          create: { name: segments[i], webdavPath: path, parentId },
        });
        idMap.set(path, record.id);
        this.logger.debug(
          { traceId, path, folderId: record.id },
          'Ancestor folder upserted',
        );
      } catch (err: any) {
        this.logger.warn(
          { traceId, path, err: err.message },
          'Failed to upsert ancestor folder',
        );
      }
    }
  }

  private getExtension(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot !== -1 ? filename.substring(dot).toLowerCase() : '';
  }

  /** Compute SHA-256 checksum — used externally by sync processor if needed. */
  async computeChecksum(filePath: string): Promise<string> {
    const stream = this.client.createReadStream(
      filePath,
    ) as unknown as Readable;
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => {
        stream.destroy();
        reject(err);
      });
    });
  }
}
