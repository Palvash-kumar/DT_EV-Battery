// Same rule as laptop-1/backend/src/domain/sensorHealth.js. The backend has
// the final say when a request is sent; this copy only drives what the form
// shows, using a ticking clock so a dead sensor turns "offline" on screen
// without waiting for a new message.
//   none | offline | suspect | live
export const DEFAULT_STALE_SEC = 30;

export function sensorHealth(reading, staleAfterSec = DEFAULT_STALE_SEC, now = Date.now()) {
  if (!reading) {
    return { state: 'none', usable: false, reason: 'No reading from the Arduino sensor has been received yet.' };
  }
  const ageSec = Math.max(0, Math.round((now - new Date(reading.timestamp).getTime()) / 1000));
  if (ageSec > staleAfterSec) {
    return {
      state: 'offline',
      usable: false,
      ageSec,
      reason: `The last Arduino sensor reading is ${ageSec} s old (limit ${staleAfterSec} s). Is the sensor laptop's OPC UA server running, the Mac's bridge running and the USB cable plugged in?`,
    };
  }
  if (reading.quality === 'suspect' || reading.quality === 'bad') {
    const notes = (reading.qualityNotes || []).join('; ');
    return {
      state: 'suspect',
      usable: false,
      ageSec,
      reason: `The latest Arduino sensor reading failed its checks${notes ? `: ${notes}` : ''}.`,
    };
  }
  return { state: 'live', usable: true, ageSec };
}
