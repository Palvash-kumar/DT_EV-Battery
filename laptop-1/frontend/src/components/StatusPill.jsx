// Text + symbol + colour, so status never depends on colour alone.
const STATUS = {
  pending: { text: 'Processing', symbol: '…', kind: 'info' },
  completed: { text: 'Completed', symbol: '✓', kind: 'ok' },
  failed: { text: 'Failed', symbol: '✕', kind: 'bad' },
  timed_out: { text: 'Timed out', symbol: '⏱', kind: 'warn' },

  available: { text: 'Available', symbol: '○', kind: 'ok' },
  charging: { text: 'Charging', symbol: '↯', kind: 'info' },
  fault: { text: 'Fault', symbol: '!', kind: 'bad' },
  offline: { text: 'Offline', symbol: '–', kind: 'muted' },

  active: { text: 'Active', symbol: '↯', kind: 'info' },
  stopped: { text: 'Stopped', symbol: '■', kind: 'muted' },

  open: { text: 'Open', symbol: '!', kind: 'bad' },
  acknowledged: { text: 'Acknowledged', symbol: '◐', kind: 'warn' },
  resolved: { text: 'Resolved', symbol: '✓', kind: 'ok' },

  info: { text: 'Info', symbol: 'i', kind: 'info' },
  warning: { text: 'Warning', symbol: '!', kind: 'warn' },
  critical: { text: 'Critical', symbol: '‼', kind: 'bad' },
};

export function StatusPill({ status }) {
  const s = STATUS[status] || { text: status, symbol: '?', kind: 'muted' };
  return (
    <span className={`pill pill-${s.kind}`}>
      <span aria-hidden="true">{s.symbol}</span> {s.text}
    </span>
  );
}
