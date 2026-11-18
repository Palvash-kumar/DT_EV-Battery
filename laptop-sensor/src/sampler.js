// Passes on the newest reading once per interval.
// The Arduino prints every ~2.2 s; with intervalMs = 5000 the OPC UA value is
// updated every 5 s with the newest reading of that window. A reading keeps
// the time it arrived, so a value is never made to look newer than it is.
// If no new reading arrived in a window, nothing is passed on.
// intervalMs = 0 passes every reading straight through.
export class LatestEvery {
  constructor(intervalMs, onSample) {
    this.intervalMs = intervalMs;
    this.onSample = onSample;
    this.pending = null;
    this.timer = null;
  }

  start() {
    if (this.intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  push(reading) {
    if (this.intervalMs > 0) this.pending = reading;
    else this.onSample(reading);
  }

  flush() {
    const reading = this.pending;
    this.pending = null;
    if (reading) this.onSample(reading);
  }

  // Forget a reading that has not been passed on (e.g. the USB was unplugged).
  clear() {
    this.pending = null;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
