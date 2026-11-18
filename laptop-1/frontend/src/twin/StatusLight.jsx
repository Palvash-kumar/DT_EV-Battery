import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';

// Lamp on top of a charger. Pulses only while a simulated session is running.
export function StatusLight({ color, pulse, position }) {
  const mat = useRef();
  useFrame(({ clock }) => {
    if (!mat.current) return;
    mat.current.emissiveIntensity = pulse ? 0.9 + 0.6 * Math.sin(clock.elapsedTime * 3) : 0.9;
  });
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.18, 16, 12]} />
      <meshStandardMaterial ref={mat} color={color} emissive={color} emissiveIntensity={0.9} />
    </mesh>
  );
}
