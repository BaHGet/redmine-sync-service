import {
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WebdavService } from './webdav.service';
import { normalizePath } from '../../shared/path.utils';

@Controller('webdav')
export class WebdavController {
  private readonly logger = new Logger(WebdavController.name);

  constructor(private readonly webdav: WebdavService) {}

  /**
   * POST /webdav/scan?path=/[documents-repository]/[some-folder]
   *
   * Recursively scans path (defaults to WEBDAV_ROOT_PATH env var) and
   * persists all folders + allowed documents to DB.
   */
  @Post('scan')
  async scan(@Query('path') path?: string) {
    const traceId = randomUUID();
    const normalizedPath = path ? normalizePath(path) : undefined;
    this.logger.log({ traceId, path: normalizedPath }, 'Scan request received');
    try {
      const result = await this.webdav.scanAndPersist(traceId, normalizedPath);
      return {
        traceId,
        scannedPath: normalizedPath ?? 'WEBDAV_ROOT_PATH (default)',
        ...result,
      };
    } catch (err: any) {
      this.logger.error(
        { traceId, path: normalizedPath, err: err.message },
        'Scan failed',
      );
      throw new InternalServerErrorException('WebDAV scan failed');
    }
  }

  /**
   * GET /webdav/documents
   *
   * Returns all documents currently stored in the DB.
   */
  @Get('documents')
  async listDocuments() {
    try {
      const documents = await this.webdav.listDocuments();
      return { total: documents.length, documents };
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'Failed to list documents');
      throw new InternalServerErrorException('Failed to list documents');
    }
  }

  /**
   * GET /webdav/folders
   *
   * Returns all folders currently stored in the DB.
   */
  @Get('folders')
  async listFolders() {
    try {
      const folders = await this.webdav.listFolders();
      return { total: folders.length, folders };
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'Failed to list folders');
      throw new InternalServerErrorException('Failed to list folders');
    }
  }

  /**
   * GET /webdav/folders-with-documents
   *
   * Returns all folders joined with their documents.
   */
  @Get('folders-with-documents')
  async listFoldersWithDocuments() {
    try {
      const folders = await this.webdav.listFoldersWithDocuments();
      return { total: folders.length, folders };
    } catch (err: any) {
      this.logger.error(
        { err: err.message },
        'Failed to list folders with documents',
      );
      throw new InternalServerErrorException(
        'Failed to list folders with documents',
      );
    }
  }
}
