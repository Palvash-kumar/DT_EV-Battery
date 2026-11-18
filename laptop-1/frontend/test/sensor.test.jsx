// Phase 10: live Arduino temperature in the New request form.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SensorStatus } from '../src/components/SensorStatus.jsx';
import { sensorHealth } from '../src/lib/sensorHealth.js';

const state = { station: null };

vi.mock('../src/hooks/MetaContext.jsx', () => ({
  useMeta: () => ({
    loading: false,
    error: null,
    meta: {
      stationId: 'STATION-001',
      sensor: { staleAfterSec: 30 },
      enums: {
        vehicleModels: ['Tesla Model 3'],
        chargerTypes: ['Level 1', 'Level 2', 'DC Fast Charger'],
        temperatureSources: ['sensor', 'simulation', 'manual'],
      },
      limits: { batteryCapacityKwhMax: 200, vehicleAgeYearsMax: 30, requestedRateKwMax: 350 },
    },
  }),
}));
vi.mock('../src/hooks/useApi.js', () => ({ useApi: () => ({ data: [], loading: false, error: null }) }));
vi.mock('../src/hooks/useStation.js', () => ({ useStation: () => ({ data: state.station, loading: false, error: null }) }));

const { NewRequest } = await import('../src/pages/NewRequest.jsx');

const sensorReading = (temperatureC, ageSec = 1, extra = {}) => ({
  temperatureC,
  source: 'sensor',
  quality: 'unknown',
  sensorId: 'LM35-A0-01',
  calibrationStatus: 'uncalibrated',
  messageId: `m-${temperatureC}-${ageSec}`,
  timestamp: new Date(Date.now() - ageSec * 1000).toISOString(),
  ...extra,
});

const renderForm = () =>
  render(
    <MemoryRouter>
      <NewRequest />
    </MemoryRouter>,
  );

describe('sensor health (frontend copy of the backend rule)', () => {
  it('live, offline, suspect, none', () => {
    expect(sensorHealth(sensorReading(31), 30).state).toBe('live');
    expect(sensorHealth(sensorReading(31, 45), 30).state).toBe('offline');
    expect(sensorHealth(sensorReading(31, 1, { quality: 'suspect' }), 30).state).toBe('suspect');
    expect(sensorHealth(null, 30).state).toBe('none');
  });

  it('status says offline in words and how to fix it', () => {
    const r = sensorReading(31, 45);
    render(<SensorStatus reading={r} health={sensorHealth(r, 30)} now={Date.now()} />);
    expect(screen.getByText(/Sensor offline/)).toBeInTheDocument();
    expect(screen.getByText(/opcua:server/)).toBeInTheDocument();
  });
});

describe('New request form with the Arduino sensor', () => {
  beforeEach(() => {
    state.station = { chargers: [], telemetry: null, sensorTelemetry: null };
  });

  it('picks "Live sensor" by itself and fills in the live value', () => {
    state.station.sensorTelemetry = sensorReading(31.26);
    renderForm();
    expect(screen.getByLabelText(/Temperature comes from/)).toHaveValue('sensor');
    const temp = screen.getByLabelText(/Ambient temperature/);
    expect(temp).toHaveValue(31.26);
    expect(temp).toHaveAttribute('readonly');
    expect(screen.getByText(/Live sensor/, { selector: '.badge' })).toBeInTheDocument();
  });

  it('follows the next reading', () => {
    state.station.sensorTelemetry = sensorReading(31.26);
    const view = renderForm();
    state.station = { ...state.station, sensorTelemetry: sensorReading(31.34) };
    view.rerender(
      <MemoryRouter>
        <NewRequest />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/Ambient temperature/)).toHaveValue(31.34);
  });

  it('a simulated reading is never offered as the sensor', () => {
    state.station.telemetry = { ...sensorReading(22), source: 'simulation' };
    renderForm();
    expect(screen.getByLabelText(/Temperature comes from/)).toHaveValue('manual');
    expect(screen.getByRole('option', { name: /Live sensor.*not available/ })).toBeDisabled();
    expect(screen.getByText(/No sensor data/)).toBeInTheDocument();
  });

  it('an old reading is shown as offline and not selected', () => {
    state.station.sensorTelemetry = sensorReading(30, 300);
    renderForm();
    expect(screen.getByLabelText(/Temperature comes from/)).toHaveValue('manual');
    expect(screen.getByText(/Sensor offline/)).toBeInTheDocument();
  });
});
