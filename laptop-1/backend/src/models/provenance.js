// Every stored value says where it came from. These five sources are the only
// ones allowed (Implementation plan, Phase 7):
//   sensor          - read from real hardware (Arduino ambient temperature)
//   simulation      - produced by a simulator or the simulated session clock
//   historical_csv  - imported from Data/ev_charging_patterns.csv
//   ml_estimate     - output of a trained model
//   manual          - typed in by a person or written by the demo seed
export const SOURCES = ['sensor', 'simulation', 'historical_csv', 'ml_estimate', 'manual'];
export const QUALITIES = ['good', 'suspect', 'bad', 'unknown'];

export const provenanceFields = (defaultSource) => ({
  source: { type: String, enum: SOURCES, required: true, default: defaultSource },
  quality: { type: String, enum: QUALITIES, default: 'unknown' },
  qualityNotes: { type: [String], default: undefined },
  // Seeded demo records are flagged so the UI can never present them as live.
  isDemo: { type: Boolean, default: false },
});
