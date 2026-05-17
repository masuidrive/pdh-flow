import * as THREE from 'three';
import { addEyes, addHair, addMouth, characterBase } from './base';
import { box, cone, cyl } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

export function buildPlanner(): THREE.Group {
  const { group } = characterBase({
    body: '#2e8b57',
    skin: '#f0d8b8',
    pants: '#1f3024',
    shoes: '#13211a',
  });
  addHair(group, '#4a3525');
  addEyes(group, { color: '#15191f' });
  addMouth(group, { type: 'flat' });
  // furrowed brows
  group.add(mesh(box(0.08, 0.012, 0.012), '#15191f', -0.07, 0.74, 0.152));
  group.add(mesh(box(0.08, 0.012, 0.012), '#15191f', 0.07, 0.74, 0.152));
  // blueprint roll tucked under arm
  const roll = mesh(cyl(0.06, 0.06, 0.32, 10), '#aaccea', 0.3, 0.4, 0.05);
  roll.rotation.z = Math.PI / 2;
  group.add(roll);
  const capA = mesh(cyl(0.065, 0.065, 0.02, 10), '#3a5fa5', 0.46, 0.4, 0.05);
  capA.rotation.z = Math.PI / 2;
  group.add(capA);
  const capB = mesh(cyl(0.065, 0.065, 0.02, 10), '#3a5fa5', 0.14, 0.4, 0.05);
  capB.rotation.z = Math.PI / 2;
  group.add(capB);
  // pencil behind ear
  const pen = mesh(cyl(0.012, 0.012, 0.12, 6), '#ffd24a', -0.16, 0.75, 0);
  pen.rotation.z = Math.PI / 2;
  group.add(pen);
  group.add(mesh(cone(0.012, 0.025, 4), '#15191f', -0.225, 0.75, 0));
  return group;
}
