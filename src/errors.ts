
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** 已知错误码 -> HTTP 状态 */
export function statusForCode(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'BAD_PARAM':
    case 'BAD_DIGEST':
    case 'EMPTY_LIST':
    case 'INDEX_OUT_OF_RANGE':
    case 'BATCH_FAILED':
    case 'INVALID_FILE':
      return 400;
    case 'CONFLICT':
      return 409;
    default:
      return 400;
  }
}
