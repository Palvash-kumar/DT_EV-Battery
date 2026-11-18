// Same rules as the backend (which takes them from charging-request.schema.json).
// Checking in the browser only saves a round trip; the server checks again.
export function validateRequest(form, meta, charger) {
  const errors = {};
  const l = meta?.limits || {};
  const n = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

  const capacity = n(form.batteryCapacityKwh);
  if (!(capacity > 0 && capacity <= (l.batteryCapacityKwhMax ?? 300))) {
    errors.batteryCapacityKwh = `Enter a capacity above 0 and up to ${l.batteryCapacityKwhMax ?? 300} kWh`;
  }
  const age = n(form.vehicleAgeYears);
  if (!(age >= 0 && age <= (l.vehicleAgeYearsMax ?? 30))) {
    errors.vehicleAgeYears = `Enter an age between 0 and ${l.vehicleAgeYearsMax ?? 30} years`;
  }
  const start = n(form.startSocPct);
  const target = n(form.targetSocPct);
  if (!(start >= 0 && start <= 100)) errors.startSocPct = 'Start SOC must be between 0 and 100 %';
  if (!(target >= 0 && target <= 100)) errors.targetSocPct = 'Target SOC must be between 0 and 100 %';
  else if (!errors.startSocPct && target <= start) errors.targetSocPct = 'Target SOC must be higher than start SOC';

  const rate = n(form.requestedRateKw);
  if (!(rate > 0 && rate <= (l.requestedRateKwMax ?? 350))) {
    errors.requestedRateKw = `Enter a rate above 0 and up to ${l.requestedRateKwMax ?? 350} kW`;
  } else if (charger && rate > charger.maxPowerKw) {
    errors.requestedRateKw = `${charger.chargerId} is rated ${charger.maxPowerKw} kW`;
  }
  if (charger && charger.chargerType !== form.chargerType) {
    errors.chargerId = `${charger.chargerId} is a ${charger.chargerType}`;
  }

  const temp = n(form.temperatureC);
  if (!(temp >= (l.temperatureCMin ?? -50) && temp <= (l.temperatureCMax ?? 60))) {
    errors.temperatureC = `Enter a temperature between ${l.temperatureCMin ?? -50} and ${l.temperatureCMax ?? 60} °C`;
  }
  if (!meta?.enums?.vehicleModels?.includes(form.model)) errors.model = 'Choose a vehicle model';
  if (!meta?.enums?.chargerTypes?.includes(form.chargerType)) errors.chargerType = 'Choose a charger type';
  return errors;
}

export function toRequestBody(form) {
  return {
    ...(form.chargerId ? { chargerId: form.chargerId } : {}),
    vehicle: {
      model: form.model,
      batteryCapacityKwh: Number(form.batteryCapacityKwh),
      vehicleAgeYears: Number(form.vehicleAgeYears),
    },
    charging: {
      startSocPct: Number(form.startSocPct),
      targetSocPct: Number(form.targetSocPct),
      chargerType: form.chargerType,
      requestedRateKw: Number(form.requestedRateKw),
    },
    environment: { temperatureC: Number(form.temperatureC), source: form.temperatureSource },
  };
}

// Server field paths ("charging.targetSocPct") -> form field names.
export function serverFieldErrors(details = []) {
  const out = {};
  for (const d of details) {
    const field = d.path?.split('.').at(-1);
    if (field && !out[field]) out[field] = d.message;
  }
  return out;
}
