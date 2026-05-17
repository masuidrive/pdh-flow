import * as THREE from 'three';
import { addEyes, addGlasses, addHair, addMouth, characterBase } from './base';
import { box, cyl, torus } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

export function buildCodeReviewer(): THREE.Group {
  const { group } = characterBase({
    body: '#6b3fa0',
    skin: '#e8b890',
    pants: '#2a313c',
    shoes: '#1a1f25',
  });
  addHair(group, '#1a1a1a');
  addEyes(group, { color: '#15191f' });
  addGlasses(group, '#222');
  addMouth(group, { type: 'frown' });
  // angled brows
  const bL = mesh(box(0.07, 0.014, 0.012), '#15191f', -0.08, 0.74, 0.152);
  bL.rotation.z = 0.35;
  group.add(bL);
  const bR = mesh(box(0.07, 0.014, 0.012), '#15191f', 0.08, 0.74, 0.152);
  bR.rotation.z = -0.35;
  group.add(bR);
  // magnifying glass
  const handle = mesh(cyl(0.02, 0.02, 0.22, 6), '#3a2a1a', 0.32, 0.42, 0.05);
  handle.rotation.set(0.7, 0, -0.32);
  group.add(handle);
  const ring = mesh(torus(0.1, 0.02, 12, 5), '#3a2a1a', 0.42, 0.58, 0.14);
  ring.rotation.set(0.45, 0.3, 0);
  group.add(ring);
  const glassMat = new THREE.MeshLambertMaterial({
    color: '#aee0ff',
    transparent: true,
    opacity: 0.55,
  });
  const glass = mesh(cyl(0.082, 0.082, 0.012, 12), glassMat, 0.42, 0.58, 0.14);
  glass.rotation.set(0.45 + Math.PI / 2, 0.3, 0);
  // glass lens material is transparent — don't wash it
  (glass.userData as { skipWash?: boolean }).skipWash = true;
  group.add(glass);
  // coffee mug
  const mug = mesh(cyl(0.06, 0.055, 0.1, 8), '#d8d8d8', -0.27, 0.42, 0.08);
  group.add(mug);
  group.add(mesh(cyl(0.061, 0.061, 0.022, 8), '#6b3fa0', -0.27, 0.46, 0.08));
  const handleMug = mesh(torus(0.03, 0.012, 8, 4), '#d8d8d8', -0.33, 0.42, 0.08);
  handleMug.rotation.y = Math.PI / 2;
  group.add(handleMug);
  group.add(mesh(cyl(0.05, 0.05, 0.006, 8), '#3a2a1a', -0.27, 0.475, 0.08));
  return group;
}
