import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  HttpRedirectResponse,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import {
  VideosService,
  InitiateUploadResult,
  VideoDetailResult,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers the video as a draft under the caller's channel and " +
      'returns presigned URLs to upload each part directly to storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        uploadId: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
        partSizeBytes: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or file size exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload in storage and enqueues background ' +
      "processing. Only the video's own channel owner may call this.",
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed — processing enqueued',
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or the submitted parts do not match what storage expects',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller is not the owner of the video channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload has already been completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteVideoUploadDto,
  ): Promise<void> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Public()
  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Get video details',
    description:
      'Returns the public fields of a video. No authentication required.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        channelId: { type: 'string', format: 'uuid' },
        title: { type: 'string', nullable: true },
        status: {
          type: 'string',
          enum: ['draft', 'processing', 'ready', 'error'],
        },
        durationSeconds: { type: 'number', nullable: true },
        errorReason: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed video id',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideoDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoDetailResult> {
    return this.videosService.getVideoDetail(id);
  }

  @Public()
  @Get(':id/stream')
  @Redirect()
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Stream a ready video',
    description:
      'Redirects to a short-lived presigned URL for inline playback. ' +
      'Requires the video to be in "ready" status.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned inline URL',
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed video id',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for delivery yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HttpRedirectResponse> {
    const url = await this.videosService.getDeliveryUrl(id, 'inline');
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':id/download')
  @Redirect()
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Download a ready video',
    description:
      'Redirects to a short-lived presigned URL with an attachment ' +
      'disposition. Requires the video to be in "ready" status.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned attachment URL',
  })
  @ApiResponse({
    status: 400,
    description: 'Malformed video id',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for delivery yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HttpRedirectResponse> {
    const url = await this.videosService.getDeliveryUrl(id, 'attachment');
    return { url, statusCode: HttpStatus.FOUND };
  }
}
