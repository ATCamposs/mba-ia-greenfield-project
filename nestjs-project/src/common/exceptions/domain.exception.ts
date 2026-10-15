export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found');
  }
}

export class VideoInvalidStatusException extends DomainException {
  constructor(status: string) {
    super(
      'VIDEO_INVALID_STATUS',
      409,
      `Operation not allowed while the video is ${status}`,
    );
  }
}

export class VideoFileTooLargeException extends DomainException {
  constructor(maxSizeBytes: number) {
    super(
      'VIDEO_FILE_TOO_LARGE',
      413,
      `Video file exceeds the maximum size of ${maxSizeBytes} bytes`,
    );
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor(contentType: string) {
    super(
      'UNSUPPORTED_VIDEO_TYPE',
      415,
      `Content type ${contentType} is not a supported video type`,
    );
  }
}

export class VideoUploadIncompleteException extends DomainException {
  constructor(reason: string) {
    super('VIDEO_UPLOAD_INCOMPLETE', 422, reason);
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor(partCount: number) {
    super(
      'INVALID_PART_NUMBER',
      400,
      `Part numbers must be between 1 and ${partCount}`,
    );
  }
}
