import { createContext, useContext } from 'react';
import { useApi } from './useApi.js';

// /api/meta: allowed values and limits from the shared JSON Schema, wording
// labels, model cards, station id. Loaded once for the whole app.
const MetaContext = createContext({ meta: null, error: null, loading: true });

export function MetaProvider({ children }) {
  const { data, error, loading, reload } = useApi('/api/meta');
  return <MetaContext.Provider value={{ meta: data, error, loading, reload }}>{children}</MetaContext.Provider>;
}

export const useMeta = () => useContext(MetaContext);
