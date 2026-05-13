import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';

// Token bucket rate limiter: max 8 requests/second (GDrive default quota)
class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRateMs: number;
  private lastRefill: number;

  constructor(maxTokens = 8, refillRateMs = 1000) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRateMs = refillRateMs;
    this.lastRefill = Date.now();
  }

  async acquire(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (Date.now() > deadline) {
        throw new Error('TokenBucket: timed out waiting for a token after 30s — possible event loop stall');
      }
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      const refilled = Math.floor((elapsed / this.refillRateMs) * this.maxTokens);
      if (refilled > 0) {
        this.tokens = Math.min(this.maxTokens, this.tokens + refilled);
        this.lastRefill = now;
      }
      if (this.tokens > 0) {
        this.tokens--;
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

@Injectable()
export class GdriveService implements OnModuleInit {
  private readonly logger = new Logger(GdriveService.name);
  private drive!: drive_v3.Drive;
  private readonly rootFolderId: string;
  private readonly bucket = new TokenBucket();

  constructor(private readonly config: ConfigService) {
    this.rootFolderId = this.config.get<string>('GDRIVE_ROOT_FOLDER_ID')!;
  }

  onModuleInit() {
    const raw = this.config.get<string>('GDRIVE_SERVICE_ACCOUNT_JSON');
    if (!raw) {
      throw new Error('GDRIVE_SERVICE_ACCOUNT_JSON is not set in environment');
    }
    let credentials: object;
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error(
        'GDRIVE_SERVICE_ACCOUNT_JSON is not valid JSON — ensure it is compact (single line)',
      );
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
    this.logger.log('Google Drive client initialized');
  }

  /** Ensure a GDrive folder exists under parentId, return its Drive ID */
  async ensureFolder(name: string, parentId: string): Promise<string> {
    await this.bucket.acquire();
    try {
      const res = await this.drive.files.list({
        q: `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      if (res.data.files && res.data.files.length > 0) {
        return res.data.files[0].id!;
      }
      await this.bucket.acquire();
      const created = await this.drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id',
        supportsAllDrives: true,
      });
      if (!created.data.id) {
        throw new Error(`GDrive did not return an ID after creating folder '${name}'`);
      }
      return created.data.id;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) throw new Error('GDrive authentication failed — check GDRIVE_SERVICE_ACCOUNT_JSON');
      if (status === 403) throw new Error(`GDrive permission denied for folder '${parentId}' — share the folder with the service account email`);
      if (status === 404) throw new Error(`GDrive folder ID '${parentId}' not found — check GDRIVE_ROOT_FOLDER_ID`);
      throw new Error(`GDrive ensureFolder failed for '${name}': ${err.message}`);
    }
  }

  /** Upload a file stream to GDrive, return the Drive file ID */
  async uploadFile(
    name: string,
    mimeType: string,
    parentId: string,
    stream: Readable,
    existingFileId?: string,
  ): Promise<string> {
    await this.bucket.acquire();
    try {
      if (existingFileId) {
        const res = await this.drive.files.update({
          fileId: existingFileId,
          media: { mimeType, body: stream },
          fields: 'id',
          supportsAllDrives: true,
        });
        if (!res.data.id) throw new Error(`GDrive did not return an ID after updating '${name}'`);
        return res.data.id;
      }
      const res = await this.drive.files.create({
        requestBody: { name, parents: [parentId], mimeType },
        media: { mimeType, body: stream },
        fields: 'id',
        supportsAllDrives: true,
      });
      if (!res.data.id) throw new Error(`GDrive did not return an ID after uploading '${name}'`);
      return res.data.id;
    } catch (err: any) {
      stream.destroy?.();
      const status = err?.response?.status;
      if (status === 401) throw new Error('GDrive authentication failed — check GDRIVE_SERVICE_ACCOUNT_JSON');
      if (status === 403) {
        const gErr = err?.response?.data?.error;
        const detail = gErr ? `${gErr.message} (${JSON.stringify(gErr.errors)})` : err.message;
        throw new Error(`GDrive 403 uploading '${name}': ${detail}`);
      }
      if (status === 429) throw new Error(`GDrive rate limit hit uploading '${name}' — BullMQ will retry`);
      throw new Error(`GDrive uploadFile failed for '${name}': ${err.message}`);
    }
  }

  getRootFolderId(): string {
    return this.rootFolderId;
  }
}
