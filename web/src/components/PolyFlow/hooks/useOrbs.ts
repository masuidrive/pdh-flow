import { useCallback, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbSpec } from '@poly/types';

// =============================================================================
// Orb particle system.
//
// Built imperatively (with object pooling) rather than as <mesh /> children
// because: (1) we may spawn 5+ orbs in the same frame for parallel reviewers,
// (2) per-orb arc trajectories are easier as imperative position math, and
// (3) keeping orbs out of React's reconciliation budget keeps the corridor
// snappy on phones.
//
// Returns a `spawn(...)` callback that components can use to enqueue an orb,
// plus a `<group />` to mount in the scene.
// =============================================================================

interface LiveOrb extends OrbSpec {
  mesh: THREE.Group;
  ball: THREE.Mesh;
  halo: THREE.Mesh;
}

export interface OrbController {
  spawn(spec: Omit<OrbSpec, 'id' | 'spawnedAt'>): void;
  clearAll(): void;
}

export function useOrbs(rootRef: React.RefObject<THREE.Group>): OrbController {
  const liveRef = useRef<LiveOrb[]>([]);
  const idRef = useRef(0);

  // --- spawn -----------------------------------------------------------
  const spawn = useCallback(
    (spec: Omit<OrbSpec, 'id' | 'spawnedAt'>): void => {
      const root = rootRef.current;
      if (!root) return;
      const id = `orb-${idRef.current++}`;

      const orbGroup = new THREE.Group();
      const size = spec.size ?? 0.16;
      const ballGeo = new THREE.SphereGeometry(size, 12, 12);
      const ballMat = new THREE.MeshLambertMaterial({
        color: spec.color,
        emissive: spec.color,
        emissiveIntensity: 0.5,
      });
      const ball = new THREE.Mesh(ballGeo, ballMat);
      ball.userData.skipWash = true;
      orbGroup.add(ball);

      const haloMat = new THREE.MeshBasicMaterial({
        color: spec.color,
        transparent: true,
        opacity: 0.35,
      });
      const halo = new THREE.Mesh(ballGeo, haloMat);
      halo.scale.setScalar(1.8);
      halo.userData.skipWash = true;
      orbGroup.add(halo);

      orbGroup.position.set(spec.from[0], spec.from[1], spec.from[2]);
      root.add(orbGroup);

      liveRef.current.push({
        ...spec,
        id,
        // -1 sentinel: we initialize the real spawn time inside useFrame
        // because that's where we have access to clock.elapsedTime. Mixing
        // performance.now() with clock.elapsedTime (as the previous
        // implementation did) produces a several-second offset between
        // the two clocks, which made orbs appear to start in the wrong
        // position and travel along a malformed arc.
        spawnedAt: -1,
        mesh: orbGroup,
        ball,
        halo,
      });
    },
    [rootRef],
  );

  // --- per-frame update -------------------------------------------------
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const live = liveRef.current;
    const root = rootRef.current;
    if (!root) return;

    for (let i = live.length - 1; i >= 0; i--) {
      const o = live[i]!;
      if (o.spawnedAt < 0) o.spawnedAt = t;
      const progress = Math.min(1, (t - o.spawnedAt) / o.duration);
      // ease-in-out for nice arc timing
      const ease =
        progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      const fx = o.from[0]; const fy = o.from[1]; const fz = o.from[2];
      const tx = o.to[0];   const ty = o.to[1];   const tz = o.to[2];
      o.mesh.position.set(
        fx + (tx - fx) * ease,
        fy + (ty - fy) * ease + Math.sin(Math.PI * progress) * o.arc,
        fz + (tz - fz) * ease,
      );
      o.halo.scale.setScalar(1.8 + Math.sin(progress * 20) * 0.2);
      o.mesh.rotation.y += 0.05;

      if (progress >= 1) {
        if (o.onArrive) o.onArrive();
        root.remove(o.mesh);
        o.ball.geometry.dispose();
        (o.ball.material as THREE.Material).dispose();
        (o.halo.material as THREE.Material).dispose();
        live.splice(i, 1);
      }
    }
  });

  const clearAll = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const o of liveRef.current) {
      root.remove(o.mesh);
      o.ball.geometry.dispose();
      (o.ball.material as THREE.Material).dispose();
      (o.halo.material as THREE.Material).dispose();
    }
    liveRef.current = [];
  }, [rootRef]);

  return { spawn, clearAll };
}
