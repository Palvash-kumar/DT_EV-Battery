// Pure helpers for the 3D twin, kept out of the scene so they can be unit tested.

// Same meaning everywhere (plan, Phase 9): available green, charging blue,
// fault/maintenance red, offline gray.
export const STATUS_COLORS = {
  available: '#2e9d4f',
  charging: '#2a78d6',
  fault: '#d13b32',
  offline: '#8a8a86',
};

export const statusColor = (status) => STATUS_COLORS[status] || STATUS_COLORS.offline;

const BAY_SPACING = 4.2;

// One bay per charger, in a row centred on the origin.
export function bayLayout(chargers = []) {
  const sorted = [...chargers].sort((a, b) => a.bay - b.bay);
  const offset = ((sorted.length - 1) * BAY_SPACING) / 2;
  return sorted.map((c, i) => ({ charger: c, x: i * BAY_SPACING - offset }));
}

// What a bay is allowed to show. A vehicle and a moving SOC bar only appear
// when a simulated session is actually running on that bay; a request that
// timed out or failed never animates anything.
export function bayVisual(charger) {
  const session = charger.status === 'charging' ? charger.session : null;
  const sim = session?.simulated || null;
  return {
    color: statusColor(charger.status),
    showVehicle: Boolean(session),
    vehicleModel: session?.vehicleModel || null,
    animate: Boolean(sim),
    socPct: sim ? sim.socPct : null,
    progressPct: sim ? sim.progressPct : null,
    socSource: sim ? sim.source : null,
  };
}

export function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
