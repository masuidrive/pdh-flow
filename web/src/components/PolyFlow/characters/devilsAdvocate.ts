import * as THREE from 'three';
import { addEyes, addMouth, characterBase } from './base';
import { box, cone, cyl } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

export function buildDevilsAdvocate(): THREE.Group {
  const { group } = characterBase({
    body: '#b8302e',
    skin: '#dca58f',
    pants: '#3d1a1a',
    shoes: '#1a0c0c',
  });
  addEyes(group, { color: '#fff' });
  // red pupils
  group.add(mesh(box(0.022, 0.028, 0.012), '#ff2a2a', -0.07, 0.66, 0.158));
  group.add(mesh(box(0.022, 0.028, 0.012), '#ff2a2a', 0.07, 0.66, 0.158));
  addMouth(group, { type: 'grin' });
  // horns
  const hL = mesh(cone(0.045, 0.16, 6), '#15191f', -0.08, 0.88, 0);
  hL.rotation.z = -0.22;
  group.add(hL);
  const hR = mesh(cone(0.045, 0.16, 6), '#15191f', 0.08, 0.88, 0);
  hR.rotation.z = 0.22;
  group.add(hR);
  // nose
  group.add(mesh(cone(0.03, 0.08, 4), '#15191f', 0, 0.51, 0.14));
  // tail
  const tail = mesh(box(0.05, 0.05, 0.22), '#b8302e', 0, 0.22, -0.2);
  tail.rotation.x = 0.45;
  group.add(tail);
  const tailTip = mesh(cone(0.05, 0.1, 4), '#15191f', 0, 0.36, -0.29);
  tailTip.rotation.x = -0.6;
  group.add(tailTip);
  // pitchfork
  const handle = mesh(cyl(0.02, 0.02, 0.55, 6), '#3a2a1a', 0.32, 0.5, 0);
  handle.rotation.z = -0.08;
  group.add(handle);
  group.add(mesh(box(0.13, 0.04, 0.025), '#d0d3d8', 0.34, 0.74, 0));
  for (let i = -1; i <= 1; i++) {
    group.add(mesh(cone(0.018, 0.08, 4), '#d0d3d8', 0.34 + i * 0.045, 0.8, 0));
  }
  return group;
}
