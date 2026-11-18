// Wording that must be used whenever these values are shown.
// Source: docs/battery_model_limitations.md (sections 2-4) and the reality
// table in Implementation_plan.md. Keep the UI and the API on these strings.
export const LABELS = {
  soh: 'Model estimate from aging-data domain',
  rul: 'Estimated RUL (model, lab conditions)',
  chargingPrediction: 'ML estimate from real charging sessions (Level 1/2) or physics estimate (DC fast)',
  ambientTemperature: 'Ambient / charger-area temperature (not battery temperature)',
  simulatedSoc: 'Simulated SOC progress',
};

export const AGING_DOMAIN = {
  chemistry: 'NMC/graphite (ISU-ILCC) and LiCoO2 18650 (NASA PCoE)',
  dataset: 'Measured on lab cells: 251 ISU-ILCC cells under 63 charge/discharge conditions and 34 NASA cells',
  eolThresholdIsAssumption: true,
};

// Added to every stored health estimate that arrives without its own notes.
export const DEFAULT_HEALTH_NOTES = [
  'SOH is a fleet-average estimate from vehicle age, not a BMS reading.',
  'Wear and RUL use how charge rate and depth of discharge changed cycle life in ISU-ILCC lab cells, scaled to a typical EV pack.',
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
