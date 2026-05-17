import * as THREE from 'three';
import { box, sphere } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

/**
 * Door exposes the hinged panel as `userData.hinge` so the animation system
 * can lerp it open / closed based on the worker's status.
 */
export interface DoorData {
  hinge: THREE.Group;
}

export function buildDoor(): THREE.Group {
  const g = new THREE.Group();
  const postColor = '#5a4030';

  // frame: two posts + top beam
  g.add(mesh(box(0.12, 1.5, 0.14), postColor, -0.5, 0.75, 0));
  g.add(mesh(box(0.12, 1.5, 0.14), postColor, 0.5, 0.75, 0));
  g.add(mesh(box(1.12, 0.16, 0.14), postColor, 0, 1.58, 0));

  // "approve" sign on top
  g.add(mesh(box(0.7, 0.22, 0.06), '#ffd24a', 0, 1.82, 0));
  const ck1 = mesh(box(0.16, 0.04, 0.02), '#2a7a3a', -0.04, 1.82, 0.04);
  ck1.rotation.z = -0.7;
  g.add(ck1);
  const ck2 = mesh(box(0.08, 0.04, 0.02), '#2a7a3a', -0.13, 1.79, 0.04);
  ck2.rotation.z = 0.7;
  g.add(ck2);

  // hinged panel — pivots around its left edge
  const hinge = new THREE.Group();
  hinge.position.set(-0.44, 0, 0);
  hinge.add(mesh(box(0.94, 1.36, 0.08), '#7c5a35', 0.47, 0.72, 0));
  // panel insets
  hinge.add(mesh(box(0.7, 0.4, 0.01), '#5a4025', 0.47, 1.05, 0.045));
  hinge.add(mesh(box(0.7, 0.4, 0.01), '#5a4025', 0.47, 0.40, 0.045));
  // knobs on both sides
  hinge.add(mesh(sphere(0.06, 8), '#ffd24a', 0.85, 0.72, 0.05));
  hinge.add(mesh(sphere(0.06, 8), '#ffd24a', 0.85, 0.72, -0.05));
  g.add(hinge);

  (g.userData as DoorData).hinge = hinge;
  return g;
}
