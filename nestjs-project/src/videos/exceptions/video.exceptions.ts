import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for delivery yet');
  }
}

export class ForbiddenNotOwnerException extends DomainException {
  constructor() {
    super(
      'FORBIDDEN_NOT_OWNER',
      403,
      'Caller is not the owner of this video channel',
    );
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_ALREADY_COMPLETED',
      409,
      'Video upload has already been completed',
    );
  }
}

export class IncompleteMultipartUploadException extends DomainException {
  constructor() {
    super(
      'INCOMPLETE_MULTIPART_UPLOAD',
      400,
      'Submitted parts do not match what storage expects',
    );
  }
}

export class FileTooLargeException extends DomainException {
  constructor() {
    super('FILE_TOO_LARGE', 400, 'File size exceeds the 10GB limit');
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'No channel found for the authenticated user',
    );
  }
}
