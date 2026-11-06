export type ErrorOptions = {
  code: string;
  message: string;
  httpStatus?: number;
  retryable?: boolean;
  meta?: Record<string, unknown>;
};

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly meta?: Record<string, unknown>;

  constructor(options: ErrorOptions) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.httpStatus = options.httpStatus ?? 500;
    this.retryable = options.retryable ?? false;
    this.meta = options.meta;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
