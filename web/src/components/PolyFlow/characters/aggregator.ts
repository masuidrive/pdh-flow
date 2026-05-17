import * as THREE from 'three';
import { box, cyl, sphere, torus } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

export function buildAggregator(): THREE.Group {
  const g = new THREE.Group();
  // body
  g.add(mesh(box(0.46, 0.36, 0.34), '#f5c84f', 0, 0.18, 0));
  // collar plate
  g.add(mesh(box(0.48, 0.06, 0.36), '#2a3a4a', 0, 0.32, 0));
  // face screen
  g.add(mesh(box(0.26, 0.18, 0.02), '#15191f', 0, 0.2, 0.18));
  // teal pixel face
  g.add(mesh(box(0.03, 0.04, 0.005), '#4ecdc4', -0.07, 0.22, 0.193));
  g.add(mesh(box(0.03, 0.04, 0.005), '#4ecdc4', 0.07, 0.22, 0.193));
  g.add(mesh(box(0.07, 0.018, 0.005), '#4ecdc4', 0, 0.15, 0.193));
  // shoulders
  g.add(mesh(box(0.08, 0.22, 0.1), '#d8a82c', -0.27, 0.22, 0));
  g.add(mesh(box(0.08, 0.22, 0.1), '#d8a82c', 0.27, 0.22, 0));
  // wheel housings
  g.add(mesh(box(0.1, 0.06, 0.12), '#2a3a4a', -0.27, 0.085, 0.02));
  g.add(mesh(box(0.1, 0.06, 0.12), '#2a3a4a', 0.27, 0.085, 0.02));
  // wheels (on its side, so rotate around Z)
  const wL = mesh(cyl(0.1, 0.1, 0.08, 10), '#15191f', -0.27, 0.1, -0.1);
  wL.rotation.z = Math.PI / 2;
  g.add(wL);
  const wR = mesh(cyl(0.1, 0.1, 0.08, 10), '#15191f', 0.27, 0.1, -0.1);
  wR.rotation.z = Math.PI / 2;
  g.add(wR);
  // funnel on head
  g.add(mesh(cyl(0.24, 0.1, 0.22, 10), '#a8acb4', 0, 0.48, 0));
  const rim = mesh(torus(0.24, 0.028, 12, 5), '#7d818a', 0, 0.58, 0);
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  // collected cubes peeking out
  const cubes: Array<{ c: string; x: number; y: number }> = [
    { c: '#ff6b6b', x: -0.08, y: 0.64 },
    { c: '#4ecdc4', x: 0.06, y: 0.68 },
    { c: '#ffd24a', x: 0.0, y: 0.62 },
  ];
  cubes.forEach((it, i) => {
    const cube = mesh(box(0.08, 0.08, 0.08), it.c, it.x, it.y, (i - 1) * 0.03);
    cube.rotation.y = i * 0.5;
    cube.rotation.x = i * 0.2;
    g.add(cube);
  });
  // back antenna
  g.add(mesh(cyl(0.012, 0.012, 0.18, 6), '#2a3a4a', 0.15, 0.5, -0.12));
  g.add(mesh(sphere(0.035, 6), '#ff6b6b', 0.15, 0.6, -0.12));
  return g;
}
