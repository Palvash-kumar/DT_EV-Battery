// One rule for "can this Arduino reading be called live?", used by the request
// check, the sensor monitor and (copied in frontend/src/lib/sensorHealth.js)
// the dashboard.
//   none     - no real sensor reading has ever been stored
//   offline  - the newest one is older than staleAfterSec
//   suspect  - the newest one is recent but failed the range/rate/consistency checks
//   live     - recent and passed the checks (or only "unverified" calibration)
export function sensorHealth(reading, staleAfterSec, now = Date.now()) {
  if (!reading) {
    return { state: 'none', usable: false, reason: 'No reading from the Arduino sensor has been received yet.' };
  }
  const ageSec = Math.max(0, Math.round((now - new Date(reading.timestamp).getTime()) / 1000));
  if (ageSec > staleAfterSec) {
    return {
      state: 'offline',
      usable: false,
      ageSec,
      reason: `The last Arduino sensor reading is ${ageSec} s old (limit ${staleAfterSec} s). Is the gateway running and the USB cable plugged in?`,
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
