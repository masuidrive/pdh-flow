import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { box, cyl, torus } from '@poly/three/primitives';
import { mesh as buildMesh, setGroupWash, tagForWash } from '@poly/three/materials';

interface FinishFlagProps {
  wash: number;
}

export function FinishFlag({ wash }: FinishFlagProps) {
  const groupRef = useRef<THREE.Group>(null);

  const flag = useMemo(() => {
    const g = new THREE.Group();
    // pole
    g.add(buildMesh(cyl(0.04, 0.04, 1.6, 8), '#2a3a4a', 0, 0.8, 0));
    // checker flag
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        const c = (i + j) % 2 === 0 ? '#fff' : '#15191f';
        g.add(buildMesh(box(0.16, 0.16, 0.02), c, 0.12 + i * 0.16, 1.4 - j * 0.16, 0));
      }
    }
    // gold ribbon at base
    g.add(buildMesh(torus(0.18, 0.04, 16, 5), '#ffd24a', 0, 0.05, 0));
    tagForWash(g);
    return g;
  }, []);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.add(flag);
    return () => {
      g.remove(flag);
    };
  }, [flag]);

  useEffect(() => {
    setGroupWash(flag, wash);
  }, [flag, wash]);

  return <group ref={groupRef} position={[0, 0.17, 0]} />;
}
