import { useEffect } from 'react';
import { getSocket, joinRoom } from '../api/socket.js';
import { useApi } from './useApi.js';

// The one source of station state for the dashboard AND the 3D twin:
// GET /api/stations/:id once, then live updates over Socket.IO.
export function useStation(stationId) {
  const result = useApi(stationId ? `/api/stations/${stationId}` : null);
  const { setData, reload } = result;

  useEffect(() => {
    if (!stationId) return undefined;
    const socket = getSocket();
    const leave = joinRoom({ stationId });
    const onStation = (view) => setData(view);
    // sensorTelemetry only ever holds a real Arduino reading (source "sensor").
    const onReading = (reading) =>
      setData((v) =>
        v ? { ...v, telemetry: reading, ...(reading.source === 'sensor' ? { sensorTelemetry: reading } : {}) } : v,
      );
    // after a reconnect we may have missed events; fetch a fresh copy
    const onReconnect = () => reload();
    socket.on('station:update', onStation);
    socket.on('telemetry:reading', onReading);
    socket.io.on('reconnect', onReconnect);
    return () => {
      leave();
      socket.off('station:update', onStation);
      socket.off('telemetry:reading', onReading);
      socket.io.off('reconnect', onReconnect);
    };
  }, [stationId, setData, reload]);

  // Simulated session progress is computed by the backend from the clock,
  // so refresh it every few seconds while something is charging.
  const charging = result.data?.chargers?.some((c) => c.status === 'charging');
  useEffect(() => {
    if (!charging) return undefined;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [charging, reload]);

  return result;
}
