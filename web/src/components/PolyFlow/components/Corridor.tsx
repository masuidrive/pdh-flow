import { useMemo } from 'react';
import * as THREE from 'three';
import { CORRIDOR_WIDTH, Z_STEP } from '@poly/config';
import type { Stage } from '@poly/types';
import { box } from '@poly/three/primitives';
import { mesh as buildMesh } from '@poly/three/materials';

interface CorridorProps {
  stages: Stage[];
}

export function Corridor({ stages }: CorridorProps) {
  const { groupOnly } = useMemo(() => buildCorridor(stages), [stages]);
  return <primitive object={groupOnly} />;
}

function buildCorridor(stages: Stage[]) {
  const g = new THREE.Group();
  if (stages.length === 0) return { groupOnly: g };

  const zMin = stages[0]!.z - Z_STEP;
  const zMax = stages[stages.length - 1]!.z + Z_STEP;
  const length = zMax - zMin + 4;
  const zCenter = (zMin + zMax) / 2;

  // main corridor strip
  const corridor = buildMesh(box(CORRIDOR_WIDTH, 0.04, length), '#fae8b0', 0, 0.02, zCenter);
  corridor.receiveShadow = true;
  g.add(corridor);

  // outer ground
  const outer = buildMesh(box(60, 0.02, length + 20), '#f0dca3', 0, 0, zCenter);
  outer.receiveShadow = true;
  g.add(outer);

  // (Previously: a continuous orange center stripe ran the full corridor
  // length. It extended past the first and last stages, producing a
  // dangling line with nothing to connect to. The dashed segments below
  // already mark stage-to-stage paths, so the center stripe is omitted.)

  // dashed path lines between consecutive stages
  for (let i = 0; i < stages.length - 1; i++) {
    const a = stages[i]!;
    const b = stages[i + 1]!;
    const startZ = a.z + a.radius;
    const endZ = b.z - b.radius;
    const segLen = endZ - startZ;
    if (segLen <= 0) continue;
    const segs = Math.max(3, Math.floor(segLen * 1.8));
    for (let s = 0; s < segs; s++) {
      const t = (s + 0.5) / segs;
      g.add(buildMesh(box(0.12, 0.02, 0.18), '#9aa2ad', 0, 0.045, startZ + t * segLen));
    }
  }

  return { groupOnly: g };
}
