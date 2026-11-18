// Wording that must be used whenever these values are shown.
// Source: docs/battery_model_limitations.md (sections 2-4) and the reality
// table in Implementation_plan.md. Keep the UI and the API on these strings.
export const LABELS = {
  soh: 'Model estimate from aging-data domain',
  rul: 'Estimated RUL (model, lab conditions)',
  chargingPrediction: 'ML estimate from the charging dataset',
  ambientTemperature: 'Ambient / charger-area temperature (not battery temperature)',
  simulatedSoc: 'Simulated SOC progress',
};

export const AGING_DOMAIN = {
  chemistry: 'Li-ion 18650 (LiCoO2 cathode)',
  dataset: 'Synthetic aging curves from a physics-based empirical model (not measured cells)',
  eolThresholdIsAssumption: true,
};

// Added to every stored health estimate that arrives without its own notes.
export const DEFAULT_HEALTH_NOTES = [
  'Estimate from aging-data domain (Li-ion 18650, LiCoO2). Not measured EV SOH.',
  'The aging data is synthetic; real EV packs (NMC, LFP, NCA) degrade differently.',
  'RUL counts cycles until SOH falls below a configurable threshold. It is not a guaranteed lifetime.',
  'Lab-to-field transfer needs calibration with real vehicle BMS data.',
];

export const NOT_CLAIMED = [
  'The model measures battery SOH',
  "The EV's battery has X% health",
  'The battery will last N more cycles',
  'Temperature from Arduino is battery temperature',
  'This model works for any EV battery',
];
