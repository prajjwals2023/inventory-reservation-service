class AppError extends Error {
  constructor(message, statusCode, code, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details = null) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

class InsufficientInventoryError extends AppError {
  constructor(message = 'Insufficient inventory available', details = null) {
    super(message, 409, 'INSUFFICIENT_INVENTORY', details);
  }
}

class InvalidStateError extends AppError {
  constructor(message = 'Invalid reservation state transition', details = null) {
    super(message, 409, 'INVALID_STATE_TRANSITION', details);
  }
}

class IdempotencyConflictError extends AppError {
  constructor(message = 'Idempotency key reuse with differing request parameters', details = null) {
    super(message, 422, 'IDEMPOTENCY_CONFLICT', details);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  // Handle Prisma known errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: `Unique constraint failed on field(s): ${err.meta?.target || 'unknown'}`,
        details: err.meta,
      },
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: err.meta?.cause || 'Record not found',
        details: err.meta,
      },
    });
  }

  // Log unhandled server errors in non-test mode
  if (process.env.NODE_ENV !== 'test') {
    console.error('Unhandled error:', err);
  }

  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal server error occurred',
      details: process.env.NODE_ENV === 'development' ? err.message : null,
    },
  });
}

module.exports = {
  AppError,
  NotFoundError,
  InsufficientInventoryError,
  InvalidStateError,
  IdempotencyConflictError,
  ValidationError,
  errorHandler,
};
