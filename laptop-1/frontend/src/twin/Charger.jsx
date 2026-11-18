import { useState } from 'react';
import { Label } from './Label.jsx';
import { StatusLight } from './StatusLight.jsx';

// A charger pedestal built from boxes: base, column, screen, lamp.
export function Charger({ charger, color, selected, pulse, onSelect }) {
  const [hover, setHover] = useState(false);
  const outline = selected || hover;
  return (
    <group
      position={[0, 0, -1.6]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(charger.chargerId);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = '';
      }}
    >
      <mesh position={[0, 0.1, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.9, 0.2, 0.6]} />
        <meshStandardMaterial color="#5c5f63" />
      </mesh>
      <mesh position={[0, 1.0, 0]} castShadow>
        <boxGeometry args={[0.6, 1.6, 0.4]} />
        <meshStandardMaterial color={outline ? '#e8eef6' : '#d6d9dc'} />
      </mesh>
      {/* status panel on the front face, coloured by status */}
      <mesh position={[0, 1.25, 0.205]}>
        <planeGeometry args={[0.44, 0.5]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} />
      </mesh>
      <StatusLight color={color} pulse={pulse} position={[0, 1.98, 0]} />
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.75, 0.9, 32]} />
          <meshBasicMaterial color="#1f5fae" />
        </mesh>
      )}
      <Label
        position={[0, 2.85, 0]}
        height={0.5}
        highlight={selected}
        lines={[
          { text: `Bay ${charger.bay} · ${charger.maxPowerKw} kW`, bold: true },
          { text: charger.status, color: color },
        ]}
      />
    </group>
  );
}
