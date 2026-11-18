import { Label } from './Label.jsx';

const WHEELS = [
  [-0.75, 0.32, 1.15],
  [0.75, 0.32, 1.15],
  [-0.75, 0.32, -1.15],
  [0.75, 0.32, -1.15],
];

// A block car parked in the bay, plus a cable to the charger. It only exists
// while a simulated session runs, and its SOC bar says it is simulated.
export function Vehicle({ model, socPct, socSource }) {
  const fill = Math.max(0, Math.min(100, socPct ?? 0)) / 100;
  return (
    <group position={[0, 0, 1.2]}>
      <mesh position={[0, 0.65, 0]} castShadow>
        <boxGeometry args={[1.6, 0.6, 3.2]} />
        <meshStandardMaterial color="#cfd5db" metalness={0.2} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.15, -0.15]} castShadow>
        <boxGeometry args={[1.35, 0.45, 1.7]} />
        <meshStandardMaterial color="#9fb3c8" metalness={0.1} roughness={0.3} />
      </mesh>
      {WHEELS.map((p) => (
        <mesh key={p.join()} position={p} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.32, 0.32, 0.22, 16]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
      ))}

      {/* charging cable: charger front (z = -1.4 in bay space) to the car's front */}
      <mesh position={[0.15, 0.55, -2.0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 1.4, 8]} />
        <meshStandardMaterial color="#222" />
      </mesh>

      {/* SOC bar above the roof; width = simulated SOC */}
      <group position={[0, 1.75, -0.15]}>
        <mesh>
          <boxGeometry args={[1.4, 0.12, 0.12]} />
          <meshStandardMaterial color="#555a60" transparent opacity={0.5} />
        </mesh>
        <mesh position={[-0.7 + 0.7 * fill, 0, 0]} scale={[Math.max(fill, 0.001), 1, 1]}>
          <boxGeometry args={[1.4, 0.14, 0.14]} />
          <meshStandardMaterial color="#2a78d6" emissive="#2a78d6" emissiveIntensity={0.4} />
        </mesh>
      </group>
      <Label
        position={[0, 1.55, 1.95]}
        height={0.46}
        dashed
        lines={[
          { text: `${model} · SOC ${Math.round(socPct ?? 0)} %`, bold: true },
          { text: socSource === 'simulation' ? 'simulated' : String(socSource), color: '#8a5a00' },
        ]}
      />
    </group>
  );
}
