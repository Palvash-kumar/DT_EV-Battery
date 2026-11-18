// Thin fetch wrapper. Every backend error has the shape
// { error: { code, message, details? } }, and is rethrown as ApiError.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || 'HTTP_ERROR';
    this.details = body?.error?.details;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { code: 'BACKEND_UNREACHABLE', message: 'Cannot reach the Laptop 1 backend.' } });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  // /api/health answers 503 with a useful body when degraded; let callers read it.
  if (!res.ok && !(res.status === 503 && path.startsWith('/api/health'))) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body),
};
