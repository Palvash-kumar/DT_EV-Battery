import { describe, expect, it } from 'vitest';
import { bayLayout, bayVisual, STATUS_COLORS, statusColor } from '../src/twin/twinState.js';

const session = {
  vehicleModel: 'Nissan Leaf',
  simulated: { source: 'simulation', socPct: 54, progressPct: 49 },
};

describe('3D twin state', () => {
  it('uses the plan colours: available green, charging blue, fault red, offline gray', () => {
    expect(statusColor('available')).toBe(STATUS_COLORS.available);
    expect(statusColor('charging')).toBe('#2a78d6');
    expect(statusColor('fault')).toBe('#d13b32');
    expect(statusColor('offline')).toBe('#8a8a86');
  });

  it('treats an unknown status as offline instead of inventing a colour', () => {
    expect(statusColor('mystery')).toBe(STATUS_COLORS.offline);
  });

  it('lays bays out in bay order, centred', () => {
    const layout = bayLayout([{ bay: 2 }, { bay: 1 }, { bay: 3 }]);
    expect(layout.map((b) => b.charger.bay)).toEqual([1, 2, 3]);
    expect(layout[0].x).toBeCloseTo(-layout[2].x);
    expect(layout[1].x).toBeCloseTo(0);
  });

  it('a charging bay with a simulated session shows a car and moving SOC', () => {
    const v = bayVisual({ status: 'charging', session });
    expect(v).toMatchObject({ showVehicle: true, animate: true, socPct: 54, socSource: 'simulation', vehicleModel: 'Nissan Leaf' });
  });

  it('a bay that only has a (timed-out) request never animates', () => {
    const v = bayVisual({ status: 'available', lastRequestId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', session: null });
    expect(v.showVehicle).toBe(false);
    expect(v.animate).toBe(false);
    expect(v.socPct).toBeNull();
  });

  it('ignores a leftover session object when the bay is no longer charging', () => {
    const v = bayVisual({ status: 'fault', session });
    expect(v.showVehicle).toBe(false);
    expect(v.animate).toBe(false);
  });
});
