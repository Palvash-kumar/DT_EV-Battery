// How each data source is shown. The four badges named in the plan are
// "Live sensor", "Simulated", "ML estimate" and "Historical"; "Manual" covers
// values typed by a person and "Demo" anything written by the seed script.
// Each badge has a symbol as well as a colour, so it still reads without colour.
export const SOURCE_BADGES = {
  sensor: { text: 'Live sensor', symbol: '●', kind: 'sensor', help: 'Read from the real Arduino sensor' },
  simulation: { text: 'Simulated', symbol: '◇', kind: 'simulated', help: 'Produced by a simulator, not measured' },
  ml_estimate: { text: 'ML estimate', symbol: '≈', kind: 'estimate', help: 'Output of a trained model, not a measurement' },
  physics_estimate: {
    text: 'Physics estimate',
    symbol: '≈',
    kind: 'estimate',
    help: 'Calculated from charger limits, vehicle specs and battery behaviour, not a measurement',
  },
  historical_csv: { text: 'Historical', symbol: '▤', kind: 'historical', help: 'Imported from ev_charging_patterns.csv' },
  manual: { text: 'Manual', symbol: '✎', kind: 'manual', help: 'Entered by a person' },
  demo: { text: 'Demo data', symbol: '◌', kind: 'demo', help: 'Written by the demo seed script; not a real site' },
};

export function badgeFor(source, { isDemo = false } = {}) {
  if (isDemo) return SOURCE_BADGES.demo;
  return SOURCE_BADGES[source] || { text: source || 'Unknown source', symbol: '?', kind: 'unknown', help: 'Source not recorded' };
}

export const QUALITY_TEXT = {
  good: 'Passed checks',
  suspect: 'Suspect',
  bad: 'Failed checks',
  unknown: 'Unverified',
};
