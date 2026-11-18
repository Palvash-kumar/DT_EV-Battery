// Draft -> Sent -> Processing -> Completed / Timed out / Failed
// `stage` is one of: draft, sent, pending, completed, timed_out, failed
const END = {
  completed: { label: 'Completed', kind: 'ok' },
  timed_out: { label: 'Timed out', kind: 'warn' },
  failed: { label: 'Failed', kind: 'bad' },
};

export function lifecycleSteps(stage) {
  const order = ['draft', 'sent', 'pending'];
  const reached = END[stage] ? 3 : Math.max(0, order.indexOf(stage));
  const steps = [
    { key: 'draft', label: 'Draft' },
    { key: 'sent', label: 'Sent' },
    { key: 'pending', label: 'Processing' },
    { key: 'end', label: END[stage]?.label || 'Result', kind: END[stage]?.kind },
  ];
  return steps.map((s, i) => ({
    ...s,
    state: i < reached ? 'done' : i === reached ? (END[stage] ? 'final' : 'current') : 'todo',
  }));
}

export function Lifecycle({ stage, detail }) {
  const steps = lifecycleSteps(stage);
  const current = steps.find((s) => s.state === 'current' || s.state === 'final');
  return (
    <div className="lifecycle">
      <ol className="lifecycle-steps">
        {steps.map((s) => (
          <li
            key={s.key}
            className={`step step-${s.state}${s.kind ? ` step-${s.kind}` : ''}`}
            aria-current={s.state === 'current' || s.state === 'final' ? 'step' : undefined}
          >
            <span className="step-dot" aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ol>
      <p className="lifecycle-text" aria-live="polite">
        Status: <strong>{current?.label}</strong>
        {detail ? ` — ${detail}` : ''}
      </p>
    </div>
  );
}
