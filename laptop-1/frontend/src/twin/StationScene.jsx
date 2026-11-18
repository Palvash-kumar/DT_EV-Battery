import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { ago, num } from '../lib/format.js';
import { Charger } from './Charger.jsx';
import { Label } from './Label.jsx';
import { bayLayout, bayVisual, prefersReducedMotion } from './twinState.js';
import { Vehicle } from './Vehicle.jsx';

function Ground({ width }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width + 6, 11]} />
        <meshStandardMaterial color="#6f7378" />
      </mesh>
      {/* kerb behind the chargers */}
      <mesh position={[0, 0.12, -2.4]} receiveShadow>
        <boxGeometry args={[width + 4, 0.24, 1.2]} />
        <meshStandardMaterial color="#a9adb1" />
      </mesh>
    </>
  );
}

function BayLines({ layout }) {
  if (!layout.length) return null;
  const xs = [layout[0].x - 2.1, ...layout.map((b) => b.x + 2.1)];
  return xs.map((x) => (
    <mesh key={x} position={[x, 0.011, 0.6]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[0.1, 5]} />
      <meshBasicMaterial color="#f2f2ee" />
    </mesh>
  ));
}

// Small post at the end of the row for the ambient temperature reading. It
// shows value, source and age; nothing in the scene is coloured by it unless
// it is a real sensor reading.
function TemperaturePost({ x, reading }) {
  const live = reading?.source === 'sensor';
  return (
    <group position={[x, 0, -2.0]}>
      <mesh position={[0, 0.9, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 1.8, 8]} />
        <meshStandardMaterial color="#9a9a96" />
      </mesh>
      <mesh position={[0, 1.85, 0]}>
        <boxGeometry args={[0.35, 0.25, 0.15]} />
        <meshStandardMaterial color={live ? '#2e9d4f' : '#c8c8c4'} />
      </mesh>
      <Label
        position={[0, 2.45, 0]}
        height={0.5}
        dashed={!live}
        lines={
          reading
            ? [
                { text: `${num(reading.temperatureC, 1)} °C ambient`, bold: true },
                { text: `${live ? 'live sensor' : 'simulated'} · ${ago(reading.timestamp)}`, color: live ? '#1d7a3a' : '#8a5a00' },
              ]
            : [{ text: 'no temperature reading' }]
        }
      />
    </group>
  );
}

export default function StationScene({ view, selected, onSelect }) {
  const layout = bayLayout(view.chargers);
  const visuals = layout.map((b) => ({ ...b, visual: bayVisual(b.charger) }));
  const anyAnimating = visuals.some((b) => b.visual.animate);
  const reduceMotion = prefersReducedMotion();
  const width = layout.length ? layout.at(-1).x - layout[0].x + 4.2 : 8;
  // Back the camera off just far enough that the row of bays plus the
  // temperature post fits across. 0.64 = tan(half the horizontal view angle)
  // for a 45° vertical FOV on a ~1.6:1 canvas.
  const dist = Math.max(10, ((width / 2 + 2.5) / 0.64) * 0.85);

  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      // Only redraw continuously while something is actually animating.
      frameloop={anyAnimating && !reduceMotion ? 'always' : 'demand'}
      camera={{ position: [0, dist * 0.55, dist], fov: 45 }}
      onPointerMissed={() => onSelect(null)}
      aria-hidden="true"
    >
      <color attach="background" args={['#cfd8e0']} />
      <hemisphereLight args={['#ffffff', '#6f7378', 0.8]} />
      <directionalLight position={[6, 10, 6]} intensity={1.4} castShadow shadow-mapSize={[1024, 1024]} />

      <Ground width={width} />
      <BayLines layout={layout} />

      {visuals.map(({ charger, x, visual }) => (
        <group key={charger.chargerId} position={[x, 0, 0]}>
          <Charger
            charger={charger}
            color={visual.color}
            selected={selected === charger.chargerId}
            pulse={visual.animate && !reduceMotion}
            onSelect={onSelect}
          />
          {visual.showVehicle && (
            <Vehicle model={visual.vehicleModel} socPct={visual.socPct} socSource={visual.socSource} />
          )}
        </group>
      ))}

      <TemperaturePost x={width / 2 + 1.2} reading={view.telemetry} />

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={6}
        maxDistance={dist * 1.6}
        minPolarAngle={0.3}
        maxPolarAngle={1.35}
        target={[0, 0.8, 0.6]}
      />
    </Canvas>
  );
}
