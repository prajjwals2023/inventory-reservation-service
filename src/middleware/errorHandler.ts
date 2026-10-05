import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: unknown;

  constructor(message: string, statusCode: number, code: string, details: unknown = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details: unknown = null) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

export class InsufficientInventoryError extends AppError {
  constructor(message = 'Insufficient inventory available', details: unknown = null) {
    super(message, 409, 'INSUFFICIENT_INVENTORY', details);
  }
}

export class InvalidStateError extends AppError {
  constructor(message = 'Invalid reservation state transition', details: unknown = null) {
    super(message, 409, 'INVALID_STATE_TRANSITION', details);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(
    message = 'Idempotency key reuse with differing request parameters',
    details: unknown = null
  ) {
    super(message, 422, 'IDEMPOTENCY_CONFLICT', details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details: unknown = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

// Extend Prisma error type minimally for error handler narrowing
interface PrismaKnownError {
  code: string;
  meta?: { target?: string; cause?: string };
}

function isPrismaError(err: unknown): err is PrismaKnownError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): Response {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  if (isPrismaError(err)) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: `Unique constraint failed on field(s): ${err.meta?.target ?? 'unknown'}`,
          details: err.meta,
        },
      });
    }

    if (err.code === 'P2025') {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: err.meta?.cause ?? 'Record not found',
          details: err.meta,
        },
      });
    }
  }

  if (process.env.NODE_ENV !== 'test') {
    console.error('Unhandled error:', err);
  }

  const message = err instanceof Error ? err.message : 'An unexpected internal server error occurred';

  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal server error occurred',
      details: process.env.NODE_ENV === 'development' ? message : null,
    },
  });
}
