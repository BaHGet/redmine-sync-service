import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SyncService } from './sync.service';
import { PrismaService } from '../../shared/prisma.service';
import { normalizePath } from '../../shared/path.utils';

@Controller('sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(
    private readonly sync: SyncService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /sync/start?path=/[documents-repository]/[crm]/[requirements]
   *
   * Starts a sync job. Optional `path` scopes the sync to documents whose
   * webdavPath starts with that prefix. Without `path`, all documents are synced.
   *
   * Documents must already be in DB (run POST /webdav/scan first).
   */
  @Post('start')
  async start(@Query('path') path?: string) {
    const normalizedPath = path ? normalizePath(path) : undefined;
    try {
      const jobId = await this.sync.startSync(normalizedPath);
      return {
        syncJobId: jobId,
        message: 'Sync job started',
        scope: normalizedPath ?? 'all documents',
      };
    } catch (err: any) {
      this.logger.error({ path: normalizedPath, err: err.message }, 'Failed to start sync job');
      throw new InternalServerErrorException('Failed to start sync job');
    }
  }

  /**
   * GET /sync/jobs
   *
   * Lists the 20 most recent sync jobs.
   */
  @Get('jobs')
  async listJobs() {
    try {
      const jobs = await this.prisma.syncJob.findMany({
        orderBy: { startedAt: 'desc' },
        take: 20,
      });
      return { total: jobs.length, jobs };
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'Failed to list sync jobs');
      throw new InternalServerErrorException('Failed to list sync jobs');
    }
  }

  /**
   * GET /sync/jobs/:id
   *
   * Returns a single sync job by ID.
   */
  @Get('jobs/:id')
  async getJob(@Param('id') id: string) {
    if (!id?.trim()) throw new BadRequestException('Job ID is required');
    try {
      const job = await this.prisma.syncJob.findUnique({ where: { id } });
      if (!job) throw new NotFoundException(`Sync job ${id} not found`);
      return job;
    } catch (err: any) {
      if (err instanceof NotFoundException || err instanceof BadRequestException) throw err;
      this.logger.error({ id, err: err.message }, 'Failed to fetch sync job');
      throw new InternalServerErrorException('Failed to fetch sync job');
    }
  }
}
