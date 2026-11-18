import { badgeFor } from '../lib/sources.js';

export function SourceBadge({ source, isDemo = false, small = false }) {
  const b = badgeFor(source, { isDemo });
  return (
    <span className={`badge badge-${b.kind}${small ? ' badge-small' : ''}`} title={b.help}>
      <span aria-hidden="true">{b.symbol}</span> {b.text}
    </span>
  );
}
