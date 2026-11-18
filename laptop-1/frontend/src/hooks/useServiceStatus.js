import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { getSocket } from '../api/socket.js';

// Backend / broker / MongoDB / ML worker status for the header.
export function useServiceStatus(pollMs = 15000) {
  const [health, setHealth] = useState(null);
  const [backendUp, setBackendUp] = useState(null);
  const [socketUp, setSocketUp] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.get('/api/health');
        if (alive) {
          setHealth(h);
          setBackendUp(true);
        }
      } catch {
        if (alive) setBackendUp(false);
      }
    };
    poll();
    const t = setInterval(poll, pollMs);

    const socket = getSocket();
    setSocketUp(socket.connected);
    const on = () => setSocketUp(true);
    const off = () => setSocketUp(false);
    const onService = () => poll();
    socket.on('connect', on);
    socket.on('disconnect', off);
    socket.on('service:status', onService);
    return () => {
      alive = false;
      clearInterval(t);
      socket.off('connect', on);
      socket.off('disconnect', off);
      socket.off('service:status', onService);
    };
  }, [pollMs]);

  return { health, backendUp, socketUp };
}
