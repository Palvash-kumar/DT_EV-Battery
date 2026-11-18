import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ChargerTable } from '../src/components/ChargerTable.jsx';
import { Lifecycle } from '../src/components/Lifecycle.jsx';
import { SourceBadge } from '../src/components/SourceBadge.jsx';
import { StatusPill } from '../src/components/StatusPill.jsx';
import { TemperatureCard } from '../src/components/TemperatureCard.jsx';

describe('components', () => {
  it('a badge always carries readable text, not just colour', () => {
    render(<SourceBadge source="simulation" />);
    expect(screen.getByText(/Simulated/)).toBeInTheDocument();
  });

  it('status pills are text, so they work without colour', () => {
    render(<StatusPill status="timed_out" />);
    expect(screen.getByText(/Timed out/)).toBeInTheDocument();
  });

  it('lifecycle announces the current step', () => {
    render(<Lifecycle stage="pending" detail="times out in 9 s" />);
    expect(screen.getByText('Processing', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/times out in 9 s/)).toBeInTheDocument();
  });

  it('temperature card says ambient and shows the source', () => {
    render(
      <TemperatureCard
        reading={{
          temperatureC: 27.5,
          source: 'simulation',
          quality: 'unknown',
          label: 'Ambient / charger-area temperature (not battery temperature)',
          timestamp: new Date().toISOString(),
          ageSec: 3,
        }}
      />,
    );
    expect(screen.getByText(/not battery temperature/)).toBeInTheDocument();
    expect(screen.getByText(/Simulated/)).toBeInTheDocument();
  });

  it('temperature card shows "No reading" rather than a made-up value', () => {
    render(<TemperatureCard reading={null} />);
    expect(screen.getByText('No reading')).toBeInTheDocument();
  });

  it('charger table marks simulated progress as simulated', () => {
    const station = {
      station: { stationId: 'S1' },
      chargers: [
        {
          chargerId: 'S1-BAY-1',
          bay: 1,
          chargerType: 'Level 2',
          maxPowerKw: 11,
          status: 'charging',
          statusSource: 'simulation',
          currentRequestId: 'a1046cd9-7790-40de-a05f-b13f0f8010d5',
          statusUpdatedAt: new Date().toISOString(),
          session: { simulated: { progressPct: 40, socPct: 44, energyKwh: 12.3 } },
        },
      ],
    };
    render(
      <MemoryRouter>
        <ChargerTable station={station} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('progressbar', { name: /simulated/i })).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getAllByText(/Simulated/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('a1046cd9')).toBeInTheDocument();
  });
});
