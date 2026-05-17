import * as THREE from 'three';
import { box, cyl, sphere } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

export function buildCritical(): THREE.Group {
  const g = new THREE.Group();
  // chunkier body
  g.add(mesh(box(0.4, 0.32, 0.3), '#e07a2a', 0, 0.16, 0));
  // belt
  g.add(mesh(box(0.42, 0.04, 0.32), '#2a3a4a', 0, 0.05, 0));
  // screen face
  g.add(mesh(box(0.26, 0.16, 0.02), '#15191f', 0, 0.2, 0.16));
  // angry brows
  const eb1 = mesh(box(0.05, 0.012, 0.005), '#ff5050', -0.05, 0.25, 0.171);
  eb1.rotation.z = -0.4;
  g.add(eb1);
  const eb2 = mesh(box(0.05, 0.012, 0.005), '#ff5050', 0.05, 0.25, 0.171);
  eb2.rotation.z = 0.4;
  g.add(eb2);
  // exclamation mark
  g.add(mesh(box(0.018, 0.045, 0.005), '#ffd24a', 0, 0.21, 0.171));
  g.add(mesh(box(0.018, 0.012, 0.005), '#ffd24a', 0, 0.17, 0.171));
  // stubby arms
  g.add(mesh(box(0.06, 0.18, 0.08), '#c5601a', -0.24, 0.2, 0));
  g.add(mesh(box(0.06, 0.18, 0.08), '#c5601a', 0.24, 0.2, 0));
  // clipboard
  const cb = mesh(box(0.16, 0.2, 0.018), '#fff', 0.28, 0.2, 0.08);
  cb.rotation.set(0, 0.2, -0.2);
  g.add(cb);
  // red X
  const x1 = mesh(box(0.11, 0.018, 0.004), '#cc2222', 0.28, 0.2, 0.09);
  x1.rotation.set(0, 0.2, -0.2 + 0.785);
  g.add(x1);
  const x2 = mesh(box(0.11, 0.018, 0.004), '#cc2222', 0.28, 0.2, 0.09);
  x2.rotation.set(0, 0.2, -0.2 - 0.785);
  g.add(x2);
  // antenna with red light
  g.add(mesh(cyl(0.012, 0.012, 0.14, 6), '#2a3a4a', 0, 0.4, 0));
  g.add(mesh(sphere(0.04, 8), '#ff5050', 0, 0.5, 0));
  // tread base
  g.add(mesh(box(0.42, 0.05, 0.34), '#15191f', 0, 0.025, 0));
  return g;
}
