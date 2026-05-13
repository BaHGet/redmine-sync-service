import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../shared/prisma.service';
import { GdriveService } from '../gdrive/gdrive.service';
import { IndexingService } from '../indexing/indexing.service';
import { SYNC_QUEUE, UPLOAD_JOB } from './sync.constants';
import { UploadJobData } from './sync.processor';
import { SyncJobStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { normalizePath } from '../../shared/path.utils';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectQueue(SYNC_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly gdrive: GdriveService,
    private readonly indexing: IndexingService,
  ) {}

  async startSync(pathPrefix?: string): Promise<string> {
    const traceId = randomUUID();
    const normalizedPrefix = pathPrefix ? normalizePath(pathPrefix) : undefined;
    this.logger.log(
      { traceId, pathPrefix: normalizedPrefix },
      'Sync job requested',
    );

    const syncJob = await this.prisma.syncJob.create({
      data: { traceId, status: SyncJobStatus.RUNNING },
    });

    this.runSync(syncJob.id, traceId, normalizedPrefix).catch((err) => {
      this.logger.error(
        {
          traceId,
          syncJobId: syncJob.id,
          pathPrefix: normalizedPrefix,
          err: err.message,
        },
        'Sync job crashed unexpectedly',
      );
    });

    return syncJob.id;
  }

  private async runSync(
    syncJobId: string,
    traceId: string,
    pathPrefix?: string,
  ): Promise<void> {
    let filesProcessed = 0;
    let filesSkipped = 0;
    let filesFailed = 0;

    try {
      // ── 1. Fetch documents from DB ─────────────────────────────────────────
      const where = pathPrefix
        ? { webdavPath: { startsWith: pathPrefix } }
        : {};

      let documents: Awaited<
        ReturnType<
          typeof this.prisma.document.findMany<{
            include: { parentFolder: true };
          }>
        >
      >;
      try {
        documents = await this.prisma.document.findMany({
          where,
          include: { parentFolder: true },
        });
      } catch (err: any) {
        throw new Error(`Failed to query documents: ${err.message}`);
      }

      this.logger.log(
        { traceId, syncJobId, documentCount: documents.length, pathPrefix },
        'Documents fetched from DB',
      );

      if (documents.length === 0) {
        this.logger.warn(
          { traceId, syncJobId, pathPrefix },
          'No documents found — completing job with zero files',
        );
        await this.prisma.syncJob.update({
          where: { id: syncJobId },
          data: {
            status: SyncJobStatus.DONE,
            completedAt: new Date(),
            filesProcessed: 0,
            filesSkipped: 0,
            filesFailed: 0,
          },
        });
        return;
      }

      // ── 2. Ensure GDrive folders exist ─────────────────────────────────────
      // Build the FULL ancestor path for every document's parent folder by
      // parsing webdavPath segments — this is robust even if DB parentId
      // links are missing (e.g. from a partial scan).
      const neededPaths = new Set<string>();
      for (const doc of documents) {
        const parts = doc.parentFolder.webdavPath.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
          neededPaths.add('/' + parts.slice(0, i).join('/'));
        }
      }

      // Fetch all needed folders from DB (by path)
      const dbFolders = await this.prisma.folder.findMany({
        where: { webdavPath: { in: [...neededPaths] } },
      });
      const folderByPath = new Map(dbFolders.map((f) => [f.webdavPath, f]));

      // Sort shallow-first so parents are created before children
      const orderedPaths = [...neededPaths].sort(
        (a, b) => a.split('/').length - b.split('/').length,
      );

      this.logger.log(
        { traceId, syncJobId, uniqueFolders: orderedPaths.length },
        'Bootstrapping GDrive folders (full path ancestry)',
      );

      const gdriveFolderMap = new Map<string, string>(); // webdavPath → gdriveId
      const root = this.gdrive.getRootFolderId();

      for (const folderPath of orderedPaths) {
        const parts = folderPath.split('/').filter(Boolean);
        const name = parts[parts.length - 1];
        const parentPath =
          parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : null;
        const parentGdriveId = parentPath
          ? (gdriveFolderMap.get(parentPath) ?? root)
          : root;

        try {
          const gdriveFolderId = await this.gdrive.ensureFolder(
            name,
            parentGdriveId,
          );
          gdriveFolderMap.set(folderPath, gdriveFolderId);
          this.logger.debug(
            { traceId, folderPath, gdriveFolderId, parentGdriveId },
            'GDrive folder ensured',
          );

          // Persist GDrive ID back to DB if we have a record for this path
          const dbFolder = folderByPath.get(folderPath);
          if (dbFolder) {
            await this.prisma.folder
              .update({
                where: { id: dbFolder.id },
                data: { googleDriveFolderId: gdriveFolderId },
              })
              .catch((e) =>
                this.logger.warn(
                  { traceId, folderPath, err: e.message },
                  'Failed to persist googleDriveFolderId to DB',
                ),
              );
          }
        } catch (err: any) {
          this.logger.error(
            { traceId, folderPath, parentGdriveId, err: err.message },
            'Failed to ensure GDrive folder — documents in this folder will be skipped',
          );
        }
      }

      // ── 3. Enqueue upload jobs ─────────────────────────────────────────────
      for (const doc of documents) {
        if (doc.syncedAt && doc.googleDriveFileId) {
          this.logger.debug(
            { traceId, docId: doc.id, webdavPath: doc.webdavPath },
            'Document already synced — skipping',
          );
          filesSkipped++;
          continue;
        }

        const gdriveFolderId = gdriveFolderMap.get(doc.parentFolder.webdavPath);
        if (!gdriveFolderId) {
          this.logger.warn(
            {
              traceId,
              docId: doc.id,
              webdavPath: doc.webdavPath,
              folderPath: doc.parentFolder.webdavPath,
            },
            'No GDrive folder mapping for document — skipping (parent folder creation likely failed)',
          );
          filesFailed++;
          continue;
        }

        const jobData: UploadJobData = {
          documentId: doc.id,
          webdavPath: doc.webdavPath,
          name: doc.name,
          mimeType: doc.mimeType,
          gdriveFolderId,
          existingGdriveFileId: doc.googleDriveFileId ?? undefined,
          traceId,
        };

        try {
          await this.queue.add(UPLOAD_JOB, jobData, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: 100,
            removeOnFail: 50,
          });
          filesProcessed++;
          this.logger.debug(
            {
              traceId,
              docId: doc.id,
              webdavPath: doc.webdavPath,
              gdriveFolderId,
            },
            'Upload job enqueued',
          );
        } catch (err: any) {
          this.logger.error(
            {
              traceId,
              docId: doc.id,
              webdavPath: doc.webdavPath,
              err: err.message,
            },
            'Failed to enqueue upload job',
          );
          filesFailed++;
        }

        if ((filesProcessed + filesSkipped + filesFailed) % 10 === 0) {
          await this.prisma.syncJob
            .update({
              where: { id: syncJobId },
              data: { filesProcessed, filesSkipped, filesFailed },
            })
            .catch((e) =>
              this.logger.warn(
                { traceId, err: e.message },
                'Periodic progress update to DB failed',
              ),
            );
        }
      }

      // ── 4. Mark job DONE ───────────────────────────────────────────────────
      await this.prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          status: SyncJobStatus.DONE,
          completedAt: new Date(),
          filesProcessed,
          filesSkipped,
          filesFailed,
        },
      });

      this.logger.log(
        {
          traceId,
          syncJobId,
          pathPrefix,
          filesProcessed,
          filesSkipped,
          filesFailed,
        },
        'Sync job complete',
      );

      // ── 5. Generate AI export ──────────────────────────────────────────────
      await this.indexing
        .generateExport(syncJobId, traceId)
        .catch((err: any) =>
          this.logger.error(
            { traceId, syncJobId, err: err.message },
            'AI export generation failed — sync job still marked DONE',
          ),
        );
    } catch (err: any) {
      this.logger.error(
        { traceId, syncJobId, pathPrefix, err: err.message },
        'Sync job failed',
      );
      await this.prisma.syncJob
        .update({
          where: { id: syncJobId },
          data: {
            status: SyncJobStatus.FAILED,
            completedAt: new Date(),
            filesProcessed,
            filesSkipped,
            filesFailed,
            error: err.message,
          },
        })
        .catch((dbErr) =>
          this.logger.error(
            { traceId, dbErr: dbErr.message },
            'Failed to persist FAILED status to DB',
          ),
        );
    }
  }
}
