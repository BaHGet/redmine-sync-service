import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'webdav';
import { SYNC_QUEUE, UPLOAD_JOB } from './sync.constants';
import { GdriveService } from '../gdrive/gdrive.service';
import { PrismaService } from '../../shared/prisma.service';

export interface UploadJobData {
  documentId: string;
  webdavPath: string;
  name: string;
  mimeType: string;
  gdriveFolderId: string;
  existingGdriveFileId?: string;
  traceId: string;
}

@Processor(SYNC_QUEUE, { concurrency: 3 })
export class SyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncProcessor.name);
  private readonly webdavClient: ReturnType<typeof createClient>;

  constructor(
    private readonly gdrive: GdriveService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
    this.webdavClient = createClient(this.config.get<string>('WEBDAV_URL')!, {
      username: this.config.get<string>('WEBDAV_USERNAME'),
      password: this.config.get<string>('WEBDAV_PASSWORD'),
    });
  }

  async process(job: Job<UploadJobData>): Promise<void> {
    if (job.name !== UPLOAD_JOB) return;

    const {
      documentId,
      webdavPath,
      name,
      mimeType,
      gdriveFolderId,
      existingGdriveFileId,
      traceId,
    } = job.data;

    this.logger.log(
      {
        traceId,
        documentId,
        webdavPath,
        gdriveFolderId,
        attempt: job.attemptsMade + 1,
      },
      'Processing upload job',
    );

    let stream: ReturnType<typeof this.webdavClient.createReadStream> | null =
      null;

    try {
      stream = this.webdavClient.createReadStream(webdavPath);

      const gdriveFileId = await this.gdrive.uploadFile(
        name,
        mimeType,
        gdriveFolderId,
        stream as any,
        existingGdriveFileId,
      );

      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          googleDriveFileId: gdriveFileId,
          syncedAt: new Date(),
        },
      });

      this.logger.log(
        { traceId, documentId, webdavPath, gdriveFileId },
        'File uploaded successfully',
      );
    } catch (err: any) {
      // Destroy the WebDAV stream to avoid leaking the connection
      if (stream) {
        try {
          (stream as any).destroy?.();
        } catch {
          /* ignore */
        }
      }

      this.logger.error(
        {
          traceId,
          documentId,
          webdavPath,
          gdriveFolderId,
          attempt: job.attemptsMade + 1,
          attemptsLeft: job.opts.attempts
            ? job.opts.attempts - job.attemptsMade - 1
            : 0,
          err: {
            message: err?.message ?? String(err),
            stack: err?.stack,
            status: err?.response?.status,
            data: err?.response?.data,
          },
        },
        'Upload job failed — will retry if attempts remain',
      );

      // Rethrow so BullMQ handles retry / dead-letter
      throw err;
    }
  }
}
