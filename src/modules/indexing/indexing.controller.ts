import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IndexingService } from './indexing.service';
import { normalizePath } from '../../shared/path.utils';

@Controller('indexing')
export class IndexingController {
  private readonly logger = new Logger(IndexingController.name);

  constructor(private readonly indexing: IndexingService) {}

  /**
   * GET /indexing/documents?path=/some/webdav/prefix
   *
   * Lists documents from the DB. Optional `path` filters by webdavPath prefix.
   */
  @Get('documents')
  async listDocuments(@Query('path') path?: string) {
    const normalizedPath = path ? normalizePath(path) : undefined;
    this.logger.log({ normalizedPath }, 'GET /indexing/documents');
    try {
      const docs = await this.indexing.queryDocuments(normalizedPath);
      return { total: docs.length, path: normalizedPath ?? 'all', documents: docs };
    } catch (err: any) {
      this.logger.error({ normalizedPath, err: err.message }, 'Failed to list documents');
      throw new InternalServerErrorException('Failed to query documents');
    }
  }

  /**
   * GET /indexing/folders?path=/some/webdav/prefix
   *
   * Lists folders from the DB. Optional `path` filters by webdavPath prefix.
   */
  @Get('folders')
  async listFolders(@Query('path') path?: string) {
    const normalizedPath = path ? normalizePath(path) : undefined;
    this.logger.log({ normalizedPath }, 'GET /indexing/folders');
    try {
      const folders = await this.indexing.queryFolders(normalizedPath);
      return { total: folders.length, path: normalizedPath ?? 'all', folders };
    } catch (err: any) {
      this.logger.error({ normalizedPath, err: err.message }, 'Failed to list folders');
      throw new InternalServerErrorException('Failed to query folders');
    }
  }

  /**
   * POST /indexing/export/:syncJobId
   *
   * Manually triggers AI export generation for a specific SyncJob ID.
   * Writes JSON to AI_EXPORT_PATH and uploads to GDrive.
   */
  @Post('export/:syncJobId')
  async triggerExport(@Param('syncJobId') syncJobId: string) {
    const traceId = randomUUID();
    this.logger.log({ syncJobId, traceId }, 'POST /indexing/export/:syncJobId');
    try {
      await this.indexing.generateExport(syncJobId, traceId);
      return { syncJobId, traceId, message: 'Export generation triggered' };
    } catch (err: any) {
      this.logger.error({ syncJobId, traceId, err: err.message }, 'Failed to trigger export');
      throw new InternalServerErrorException('Failed to generate export');
    }
  }

  /**
   * GET /indexing/export?path=/some/webdav/prefix
   *
   * Returns an inline JSON export of documents (and their folders) from the DB,
   * scoped by optional webdavPath prefix. Does NOT write to disk or GDrive.
   * Useful for quick inspection without running a full sync.
   */
  @Get('export')
  async inlineExport(@Query('path') path?: string) {
    const normalizedPath = path ? normalizePath(path) : undefined;
    this.logger.log({ normalizedPath }, 'GET /indexing/export');

    try {
      const [docs, folders] = await Promise.all([
        this.indexing.queryDocuments(normalizedPath),
        this.indexing.queryFolders(normalizedPath),
      ]);

      return {
        exportedAt: new Date().toISOString(),
        path: normalizedPath ?? 'all',
        folderCount: folders.length,
        documentCount: docs.length,
        folders: folders.map((f) => ({
          id: f.id,
          name: f.name,
          webdavPath: f.webdavPath,
          googleDriveFolderId: f.googleDriveFolderId,
          parentId: f.parentId,
        })),
        documents: docs.map((d) => ({
          id: d.id,
          name: d.name,
          webdavPath: d.webdavPath,
          mimeType: d.mimeType,
          size: d.size.toString(),
          checksum: d.checksum,
          googleDriveFileId: d.googleDriveFileId,
          syncedAt: d.syncedAt,
          lastModified: d.lastModified,
          folder: d.parentFolder.webdavPath,
        })),
      };
    } catch (err: any) {
      this.logger.error({ normalizedPath, err: err.message }, 'Failed to generate inline export');
      throw new InternalServerErrorException('Failed to generate export');
    }
  }
}
