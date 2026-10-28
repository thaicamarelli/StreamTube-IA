import { DomainException } from '../../common/exceptions/domain.exception';
import {
  VideoNotFoundException,
  VideoNotReadyException,
  ForbiddenNotOwnerException,
  UploadAlreadyCompletedException,
  IncompleteMultipartUploadException,
  FileTooLargeException,
} from './video.exceptions';

describe('Video domain exceptions', () => {
  it('VideoNotFoundException exposes errorCode 404', () => {
    const exception = new VideoNotFoundException();
    expect(exception).toBeInstanceOf(DomainException);
    expect(exception.errorCode).toBe('VIDEO_NOT_FOUND');
    expect(exception.httpStatus).toBe(404);
    expect(exception.message).toBe('Video not found');
    expect(exception.name).toBe('VideoNotFoundException');
  });

  it('VideoNotReadyException exposes errorCode 409', () => {
    const exception = new VideoNotReadyException();
    expect(exception).toBeInstanceOf(DomainException);
    expect(exception.errorCode).toBe('VIDEO_NOT_READY');
    expect(exception.httpStatus).toBe(409);
    expect(exception.message).toBe('Video is not ready for delivery yet');
    expect(exception.name).toBe('VideoNotReadyException');
  });

  it('ForbiddenNotOwnerException exposes errorCode 403', () => {
    const exception = new ForbiddenNotOwnerException();
    expect(exception).toBeInstanceOf(DomainException);
    expect(exception.errorCode).toBe('FORBIDDEN_NOT_OWNER');
    expect(exception.httpStatus).toBe(403);
    expect(exception.message).toBe(
      'Caller is not the owner of this video channel',
    );
    expect(exception.name).toBe('ForbiddenNotOwnerException');
  });

  it('UploadAlreadyCompletedException exposes errorCode 409', () => {
    const exception = new UploadAlreadyCompletedException();
    expect(exception).toBeInstanceOf(DomainException);
    expect(exception.errorCode).toBe('UPLOAD_ALREADY_COMPLETED');
    expect(exception.httpStatus).toBe(409);
    expect(exception.message).toBe(
      'Video upload has already been completed',
    );
    expect(exception.name).toBe('UploadAlreadyCompletedException');
  });

  it('IncompleteMultipartUploadException exposes errorCode 400', () => {
    const exception = new IncompleteMultipartUploadException();
    expect(exception).toBeInstanceOf(DomainException);
    expect(exception.errorCode).toBe('INCOMPLETE_MULTIPART_UPLOAD');
    expect(exception.httpStatus).toBe(400);
    expect(exception.message).toBe(
      'Submitted parts do not match what storage expects',
    );
    expect(exception.name).toBe('IncompleteMultipartUploadException');
  });

  it('FileTooLargeException exposes errorCode 400', () => {
    const exception = new FileTooLargeException();
    expect(exception).toBeInstanceOf(DomainException);
    expect(exception.errorCode).toBe('FILE_TOO_LARGE');
    expect(exception.httpStatus).toBe(400);
    expect(exception.message).toBe('File size exceeds the 10GB limit');
    expect(exception.name).toBe('FileTooLargeException');
  });
});
