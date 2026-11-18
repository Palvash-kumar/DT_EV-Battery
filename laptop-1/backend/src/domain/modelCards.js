import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Short "model cards" for the dashboard, read from the metadata JSON files
// that the Phase 2/3 training scripts wrote. The backend never loads the
// models themselves; it only reports how they scored on held-out data.
const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.MODEL_METADATA_DIR
  ? path.resolve(process.env.MODEL_METADATA_DIR)
  : path.resolve(here, '../../../../laptop-2/models');

const FILES = {
  duration: 'duration_model_metadata.json',
  energy: 'energy_model_metadata.json',
  cost: 'cost_model_metadata.json',
  soh: 'soh_model_metadata.json',
  rul: 'rul_model_metadata.json',
  life: 'battery_life_model_metadata.json',
};

function card(file) {
  const full = path.join(DIR, file);
  if (!existsSync(full)) return null;
  try {
    const m = JSON.parse(readFileSync(full, 'utf8'));
    const scores = m.all_results?.[m.selected_model] || {};
    return {
      target: m.target,
      units: m.target_units,
      selectedModel: m.selected_model,
      version: String(m.training_date || '').slice(0, 10),
      testMae: scores.test_mae ?? null,
      testRmse: scores.test_rmse ?? null,
      testR2: scores.test_r2 ?? null,
      testRows: m.test_rows ?? null,
      testBatteries: m.test_batteries ?? undefined,
      split: m.split ?? null,
      dataset: m.dataset ?? null,
      cvMae: scores.cv_mae ?? null,
      cvR2: scores.cv_r2 ?? null,
      leaveOneBatteryOut: m.leave_one_battery_out ?? null,
      bestMlModel: m.best_ml_model ?? null,
      bestMlCvR2: m.all_results?.[m.best_ml_model]?.cv_r2 ?? null,
      permutationPValue: m.permutation_test?.p_value ?? null,
      hasUsefulSignal: m.permutation_test?.has_useful_signal ?? null,
      limitations: m.limitations ?? [],
    };
  } catch {
    return null;
  }
}

let cached;
export function modelCards() {
  if (!cached) cached = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, card(f)]));
  return cached;
}
