import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

// Loads a GET endpoint and tracks loading / error. `path` = null skips loading.
// `loading` is true whenever there is no answer yet for the *current* path,
// including the first render after the path changes.
export function useApi(path) {
  const [state, setState] = useState({ path: null, data: null, error: null, fetching: false });
  const current = useRef(path);
  current.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, fetching: true }));
    try {
      const data = await api.get(path);
      if (current.current === path) setState({ path, data, error: null, fetching: false });
    } catch (error) {
      if (current.current === path) setState((s) => ({ ...s, path, error, fetching: false }));
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  const setData = useCallback((fn) => setState((s) => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn })), []);

  const fresh = state.path === path;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: Boolean(path) && (!fresh || state.fetching),
    reload: load,
    setData,
  };
}
