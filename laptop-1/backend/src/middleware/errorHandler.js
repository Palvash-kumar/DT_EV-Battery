import { ZodError } from 'zod';
import { AppError } from '../errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

// Every error leaves the API in the same shape: { error: { code, message, details? } }.
// Stack traces only go to the log, never to the client.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request body or parameters are invalid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err.name === 'CastError' || err.name === 'ValidationError') {
    return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: err.message } });
  }

  (req.log || console).error({ err }, 'unhandled error');
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' } });
}
