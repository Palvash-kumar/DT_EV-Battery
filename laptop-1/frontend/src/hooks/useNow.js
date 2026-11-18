import { useEffect, useState } from 'react';

// Current time, refreshed every `everyMs`. Used where "how old is this
// reading" must keep counting even when no new message arrives.
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
