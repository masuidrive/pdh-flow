import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { box, cyl, sphere } from '@poly/three/primitives';
import { mesh as buildMesh, setGroupWash, tagForWash } from '@poly/three/materials';

interface MachineProps {
  active: boolean;
  wash: number;
}

/**
 * Server-rack style machine for `system_step` stages. When active, its
 * green LEDs flicker via tick-loop scaling (no opacity changes — we keep
 * to the same no-opacity rule as everything else).
 */
export function Machine({ active, wash }: MachineProps) {
  const groupRef = useRef<THREE.Group>(null);
  const ledsRef = useRef<THREE.Mesh[]>([]);

  const machineGroup = useMemo(() => {
    const g = new THREE.Group();
    // body
    g.add(buildMesh(box(1.0, 0.9, 0.7), '#3a4a5a', 0, 0.45, 0));
    // top vents
    for (let i = 0; i < 3; i++) {
      g.add(buildMesh(box(0.7, 0.04, 0.05), '#15191f', 0, 0.92, -0.2 + i * 0.2));
    }
    // green LEDs (collect refs for animation)
    const leds: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const led = buildMesh(sphere(0.04, 6), '#3ec06a', -0.35, 0.7 - i * 0.12, 0.36);
      g.add(led);
      leds.push(led);
    }
    ledsRef.current = leds;
    // screen with code lines
    g.add(buildMesh(box(0.5, 0.3, 0.02), '#15191f', 0.05, 0.65, 0.36));
    for (let i = 0; i < 4; i++) {
      g.add(buildMesh(
        box(0.36 - i * 0.06, 0.02, 0.005),
        '#a8e6a8',
        -0.05 + i * 0.02,
        0.75 - i * 0.06,
        0.371,
      ));
    }
    // big red start button
    g.add(buildMesh(cyl(0.08, 0.08, 0.04, 12), '#cc2222', 0.35, 0.91, 0.0));
    // pipe
    g.add(buildMesh(cyl(0.05, 0.05, 0.4, 8), '#888', -0.55, 0.7, 0));
    tagForWash(g);
    return g;
  }, []);

  // Mount + wash
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.add(machineGroup);
    return () => {
      g.remove(machineGroup);
    };
  }, [machineGroup]);

  useEffect(() => {
    setGroupWash(machineGroup, wash);
  }, [machineGroup, wash]);

  useFrame(({ clock }) => {
    if (!active) {
      ledsRef.current.forEach((led) => led.scale.setScalar(1));
      return;
    }
    const t = clock.elapsedTime;
    ledsRef.current.forEach((led, i) => {
      led.scale.setScalar(1 + Math.sin(t * 8 + i) * 0.25);
    });
  });

  return <group ref={groupRef} position={[0, 0.17, 0]} />;
}
