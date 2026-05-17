import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { StationKind } from '@poly/types';
import { cyl } from '@poly/three/primitives';
import { mesh as buildMesh, setGroupWash, tagForWash } from '@poly/three/materials';

interface StationProps {
  kind: StationKind;
  radius: number;
  active: boolean;
  wash: number;
}

const BASE_COLORS: Record<StationKind, string> = {
  normal: '#d9c891',
  review: '#e8d5a3',
  aggregator: '#f3d589',
  gate: '#d3b888',
  system: '#a8b5c0',
  terminal: '#a8e6a8',
};

const INNER_COLORS: Record<StationKind, string> = {
  normal: '#c1ad6e',
  review: '#caa86c',
  aggregator: '#daa44a',
  gate: '#b69968',
  system: '#88959f',
  terminal: '#8ccc8c',
};

export function Station({ kind, radius, active, wash }: StationProps) {
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  // Build the pad meshes once — wash-tagged for color manipulation.
  const padGroup = useMemo(() => {
    const g = new THREE.Group();
    const pad = buildMesh(cyl(radius, radius, 0.16, 24), BASE_COLORS[kind], 0, 0.08, 0);
    pad.castShadow = false;
    pad.receiveShadow = true;
    g.add(pad);
    const inner = buildMesh(
      cyl(radius * 0.85, radius * 0.85, 0.02, 24),
      INNER_COLORS[kind],
      0,
      0.165,
      0,
    );
    g.add(inner);
    tagForWash(g);
    return g;
  }, [kind, radius]);

  // Apply color wash whenever it changes
  useEffect(() => {
    setGroupWash(padGroup, wash);
  }, [padGroup, wash]);

  // Mount the pad group
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.add(padGroup);
    return () => {
      g.remove(padGroup);
    };
  }, [padGroup]);

  // Pulse the glow ring when active
  useFrame(({ clock }) => {
    const m = ringRef.current;
    if (!m) return;
    const mat = m.material as THREE.MeshBasicMaterial;
    if (active) {
      const t = clock.elapsedTime;
      mat.opacity = 0.4 + Math.sin(t * 4) * 0.25;
      const s = 1 + Math.sin(t * 3) * 0.04;
      m.scale.set(s, s, s);
    } else {
      mat.opacity = 0;
      m.scale.set(1, 1, 1);
    }
  });

  return (
    <group ref={groupRef}>
      <mesh
        ref={ringRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.005, 0]}
        userData={{ skipWash: true }}
      >
        <ringGeometry args={[radius * 0.98, radius * 1.14, 32]} />
        <meshBasicMaterial
          color={'#ffd24a'}
          side={THREE.DoubleSide}
          transparent
          opacity={0}
        />
      </mesh>
    </group>
  );
}
