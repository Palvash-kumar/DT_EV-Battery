import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Lifecycle } from '../components/Lifecycle.jsx';
import { Notice } from '../components/Notice.jsx';
import { SourceBadge } from '../components/SourceBadge.jsx';
import { ErrorBox, Loading } from '../components/States.jsx';
import { useMeta } from '../hooks/MetaContext.jsx';
import { useApi } from '../hooks/useApi.js';
import { useStation } from '../hooks/useStation.js';
import { num } from '../lib/format.js';
import { serverFieldErrors, toRequestBody, validateRequest } from '../lib/validateRequest.js';

const START = {
  vehicleId: '',
  model: 'Tesla Model 3',
  batteryCapacityKwh: '75',
  vehicleAgeYears: '3',
  startSocPct: '25',
  targetSocPct: '80',
  chargerType: 'DC Fast Charger',
  chargerId: '',
  requestedRateKw: '50',
  temperatureC: '25',
  temperatureSource: 'manual',
};

const SOURCE_TEXT = {
  manual: 'Manual (typed in)',
  simulation: 'Simulated',
  sensor: 'Live sensor (latest Arduino reading)',
};

function Field({ id, label, unit, error, hint, children }) {
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {unit && <span className="unit"> ({unit})</span>}
      </label>
      {children}
      {hint && !error && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function NewRequest() {
  const { meta, loading: metaLoading, error: metaError } = useMeta();
  const vehicles = useApi('/api/vehicles');
  const station = useStation(meta?.stationId);
  const navigate = useNavigate();

  const [form, setForm] = useState(START);
  const [errors, setErrors] = useState({});
  const [stage, setStage] = useState('draft');
  const [submitError, setSubmitError] = useState(null);

  const chargers = station.data?.chargers || [];
  const charger = chargers.find((c) => c.chargerId === form.chargerId);
  const reading = station.data?.telemetry;
  const liveSensor = reading && reading.source === 'sensor' && reading.ageSec <= 120 ? reading : null;
  const socDelta = Number(form.targetSocPct) - Number(form.startSocPct);
  const roughEnergy = useMemo(
    () => (Number(form.batteryCapacityKwh) * socDelta) / 100,
    [form.batteryCapacityKwh, socDelta],
  );

  if (metaLoading) return <Loading what="form" />;
  if (metaError) return <ErrorBox error={metaError} />;

  const set = (field) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((er) => ({ ...er, [field]: undefined }));
  };

  const pickVehicle = (e) => {
    const v = vehicles.data?.find((x) => x.vehicleId === e.target.value);
    setForm((f) =>
      v
        ? { ...f, vehicleId: v.vehicleId, model: v.model, batteryCapacityKwh: String(v.batteryCapacityKwh), vehicleAgeYears: String(v.vehicleAgeYears) }
        : { ...f, vehicleId: '' },
    );
  };

  const pickCharger = (e) => {
    const c = chargers.find((x) => x.chargerId === e.target.value);
    setForm((f) => ({
      ...f,
      chargerId: e.target.value,
      ...(c ? { chargerType: c.chargerType, requestedRateKw: String(Math.min(Number(f.requestedRateKw) || c.maxPowerKw, c.maxPowerKw)) } : {}),
    }));
    setErrors((er) => ({ ...er, chargerId: undefined, chargerType: undefined, requestedRateKw: undefined }));
  };

  const pickSource = (e) => {
    const source = e.target.value;
    setForm((f) => ({ ...f, temperatureSource: source, ...(source === 'sensor' && liveSensor ? { temperatureC: String(liveSensor.temperatureC) } : {}) }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitError(null);
    const found = validateRequest(form, meta, charger);
    if (form.temperatureSource === 'sensor' && !liveSensor) {
      found.temperatureSource = 'No live sensor reading in the last 2 minutes. Use manual or simulated.';
    }
    setErrors(found);
    if (Object.keys(found).length) return;

    setStage('sent');
    try {
      const res = await api.post('/api/predictions/charging', toRequestBody(form));
      navigate(`/requests/${res.requestId}`);
    } catch (err) {
      if (err.code === 'BROKER_UNAVAILABLE' && err.details?.requestId) {
        // The request was saved as failed; its page offers a retry.
        navigate(`/requests/${err.details.requestId}`);
        return;
      }
      setStage('draft');
      setErrors(serverFieldErrors(err.details));
      setSubmitError(err);
    }
  };

  const describe = (id) => (errors[id] ? `${id}-error` : undefined);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>New charging request</h1>
          <p className="muted">Estimate charging duration and energy for one session. The prediction runs on Laptop 2.</p>
        </div>
      </header>

      <Lifecycle stage={stage} detail={stage === 'draft' ? 'fill in the form and send it' : 'sending to the backend'} />

      <form className="card form" onSubmit={submit} noValidate>
        <fieldset>
          <legend>Vehicle</legend>
          <Field id="vehicleId" label="Start from a demo profile" hint="Optional. Fills in model, capacity and age.">
            <select id="vehicleId" value={form.vehicleId} onChange={pickVehicle}>
              <option value="">— none —</option>
              {vehicles.data?.map((v) => (
                <option key={v.vehicleId} value={v.vehicleId}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="model" label="Vehicle model" error={errors.model} hint="Only the five models the ML model was trained on.">
            <select id="model" value={form.model} onChange={set('model')} aria-describedby={describe('model')}>
              {meta.enums.vehicleModels.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field id="batteryCapacityKwh" label="Battery capacity" unit="kWh" error={errors.batteryCapacityKwh}>
            <input id="batteryCapacityKwh" type="number" inputMode="decimal" step="0.1" min="0" max={meta.limits.batteryCapacityKwhMax} value={form.batteryCapacityKwh} onChange={set('batteryCapacityKwh')} aria-invalid={Boolean(errors.batteryCapacityKwh)} aria-describedby={describe('batteryCapacityKwh')} />
          </Field>
          <Field id="vehicleAgeYears" label="Vehicle age" unit="years" error={errors.vehicleAgeYears}>
            <input id="vehicleAgeYears" type="number" inputMode="decimal" step="0.5" min="0" max={meta.limits.vehicleAgeYearsMax} value={form.vehicleAgeYears} onChange={set('vehicleAgeYears')} aria-invalid={Boolean(errors.vehicleAgeYears)} aria-describedby={describe('vehicleAgeYears')} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>Charging</legend>
          <Field id="startSocPct" label="Current state of charge" unit="%" error={errors.startSocPct}>
            <input id="startSocPct" type="number" inputMode="decimal" min="0" max="100" value={form.startSocPct} onChange={set('startSocPct')} aria-invalid={Boolean(errors.startSocPct)} aria-describedby={describe('startSocPct')} />
          </Field>
          <Field id="targetSocPct" label="Target state of charge" unit="%" error={errors.targetSocPct}>
            <input id="targetSocPct" type="number" inputMode="decimal" min="0" max="100" value={form.targetSocPct} onChange={set('targetSocPct')} aria-invalid={Boolean(errors.targetSocPct)} aria-describedby={describe('targetSocPct')} />
          </Field>
          <Field id="chargerId" label="Charger bay" error={errors.chargerId} hint="Optional. A bay fixes the charger type and caps the rate at its rating.">
            <select id="chargerId" value={form.chargerId} onChange={pickCharger} aria-describedby={describe('chargerId')}>
              <option value="">— no specific bay —</option>
              {chargers.map((c) => (
                <option key={c.chargerId} value={c.chargerId}>
                  Bay {c.bay} · {c.chargerType} · {c.maxPowerKw} kW ({c.status})
                </option>
              ))}
            </select>
          </Field>
          <Field id="chargerType" label="Charger type" error={errors.chargerType}>
            <select id="chargerType" value={form.chargerType} onChange={set('chargerType')} disabled={Boolean(charger)}>
              {meta.enums.chargerTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field id="requestedRateKw" label="Requested charging rate" unit="kW" error={errors.requestedRateKw} hint={charger ? `Bay ${charger.bay} is rated ${charger.maxPowerKw} kW.` : undefined}>
            <input id="requestedRateKw" type="number" inputMode="decimal" step="0.1" min="0" max={charger?.maxPowerKw ?? meta.limits.requestedRateKwMax} value={form.requestedRateKw} onChange={set('requestedRateKw')} aria-invalid={Boolean(errors.requestedRateKw)} aria-describedby={describe('requestedRateKw')} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>Environment</legend>
          <Field id="temperatureSource" label="Temperature comes from" error={errors.temperatureSource}>
            <select id="temperatureSource" value={form.temperatureSource} onChange={pickSource} aria-describedby={describe('temperatureSource')}>
              {meta.enums.temperatureSources.map((s) => (
                <option key={s} value={s} disabled={s === 'sensor' && !liveSensor}>
                  {SOURCE_TEXT[s] || s}
                  {s === 'sensor' && !liveSensor ? ' — no live reading' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field id="temperatureC" label="Ambient temperature" unit="°C" error={errors.temperatureC} hint="Air temperature at the charger, not battery temperature.">
            <input id="temperatureC" type="number" inputMode="decimal" step="0.1" value={form.temperatureC} onChange={set('temperatureC')} readOnly={form.temperatureSource === 'sensor'} aria-invalid={Boolean(errors.temperatureC)} aria-describedby={describe('temperatureC')} />
          </Field>
          <p className="badges">
            This value will be recorded as <SourceBadge source={form.temperatureSource} />
          </p>
        </fieldset>

        {socDelta > 0 && roughEnergy > 0 && (
          <p className="small muted">
            For reference: {form.batteryCapacityKwh} kWh × {socDelta} % = {num(roughEnergy, 1)} kWh added to the battery, before charging losses.
          </p>
        )}

        {submitError && !Object.keys(errors).some((k) => errors[k]) && <ErrorBox error={submitError} />}

        <div className="form-actions">
          <button className="btn btn-primary" type="submit" disabled={stage === 'sent'}>
            {stage === 'sent' ? 'Sending…' : 'Send request'}
          </button>
          <button className="btn" type="button" onClick={() => { setForm(START); setErrors({}); }}>
            Reset
          </button>
        </div>
      </form>

      <Notice title="What you get back">
        Two numbers from models trained on <code>ev_charging_patterns.csv</code>: charging duration (hours) and energy (kWh). They are
        estimates, not measurements, and on held-out data they were not much better than predicting the average. The result page shows
        the exact error figures.
      </Notice>
    </>
  );
}
