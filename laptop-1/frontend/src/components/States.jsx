export function Loading({ what = 'data' }) {
  return (
    <p className="state state-loading" role="status">
      Loading {what}…
    </p>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="state state-error" role="alert">
      <strong>{error.code === 'BACKEND_UNREACHABLE' ? 'Backend not reachable.' : 'Something went wrong.'}</strong>{' '}
      {error.message}
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="state state-empty">{children}</div>;
}
