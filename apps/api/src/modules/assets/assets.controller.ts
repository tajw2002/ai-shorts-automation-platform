import {
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppConfig } from '@/config/app-config';
import { NotFoundError, ValidationError } from '@/common/errors';
import { parseByteRange } from '@/common/utils/http-range';
import { AssetsService } from './assets.service';

/**
 * Asset access.
 *
 * With cloud storage the dashboard follows a short-lived signed URL and never
 * touches this API. The streaming route exists for the local-storage provider,
 * which has no signing mechanism — there, the operator's session *is* the
 * authorisation, which is why this route is behind the normal guard.
 */
@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly config: AppConfig,
  ) {}

  @Get(':id/url')
  async getUrl(@Param('id') id: string) {
    return { url: await this.assets.getPreviewUrl(id) };
  }

  /**
   * Streams an object from local storage.
   *
   * Only enabled for the local provider: with GCS this would proxy bytes through
   * the API for no reason, and signed URLs are strictly better.
   */
  @Get('content')
  @Header('Cache-Control', 'private, max-age=300')
  async getContent(
    @Query('key') key: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (this.config.providers.storage !== 'local') {
      throw new ValidationError(
        'Direct asset streaming is only available with the local storage provider. ' +
          'Use /assets/:id/url for a signed URL.',
      );
    }
    if (!key) throw new ValidationError('A storage key is required.');

    // Path traversal is rejected inside the storage provider, which owns the
    // storage root and is the only component that can validate against it.
    const object = await this.assets.statObject(key);
    if (!object) throw new NotFoundError('Stored object', key);

    // Byte ranges are not optional for media: Safari probes with `bytes=0-1` and
    // refuses to play a <video> unless it gets a 206 back.
    response.setHeader('Content-Type', guessContentType(key));
    response.setHeader('Accept-Ranges', 'bytes');

    const range = parseByteRange(rangeHeader, object.sizeBytes);
    if (range === 'unsatisfiable') {
      response.status(416);
      response.setHeader('Content-Range', `bytes */${object.sizeBytes}`);
      return new StreamableFile(Buffer.alloc(0));
    }
    if (range) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${object.sizeBytes}`);
      response.setHeader('Content-Length', String(range.end - range.start + 1));
      return new StreamableFile(await this.assets.openStream(key, range));
    }

    response.setHeader('Content-Length', String(object.sizeBytes));
    return new StreamableFile(await this.assets.openStream(key));
  }
}

function guessContentType(key: string): string {
  if (key.endsWith('.mp4')) return 'video/mp4';
  if (key.endsWith('.mp3')) return 'audio/mpeg';
  if (key.endsWith('.wav')) return 'audio/wav';
  if (key.endsWith('.m4a')) return 'audio/mp4';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.srt') || key.endsWith('.ass')) return 'text/plain';
  return 'application/octet-stream';
}
