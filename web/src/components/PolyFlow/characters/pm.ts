import * as THREE from 'three';
import { addEyes, addHair, addMouth, characterBase } from './base';
import { box, sphere, torus } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

export function buildPM(): THREE.Group {
  const { group } = characterBase({
    body: '#3d4655',
    skin: '#f4c89a',
    pants: '#2a313c',
    shoes: '#0e1218',
  });
  addHair(group, '#4a3525');
  addEyes(group, { color: '#15191f' });
  addMouth(group, { type: 'smile' });
  // shirt collar
  group.add(mesh(box(0.22, 0.08, 0.04), '#fff', 0, 0.46, 0.135));
  group.add(mesh(box(0.06, 0.05, 0.04), '#c63d3d', 0, 0.43, 0.142));
  // tie
  group.add(mesh(box(0.07, 0.18, 0.025), '#c63d3d', 0, 0.32, 0.144));
  // headset band + earcups
  const band = mesh(torus(0.16, 0.014, 12, 4), '#15191f', 0, 0.78, 0);
  band.rotation.z = Math.PI / 2;
  group.add(band);
  group.add(mesh(box(0.05, 0.07, 0.05), '#15191f', -0.165, 0.65, 0));
  group.add(mesh(box(0.05, 0.07, 0.05), '#15191f', 0.165, 0.65, 0));
  // mic boom
  group.add(mesh(box(0.02, 0.02, 0.16), '#15191f', -0.13, 0.62, 0.08));
  group.add(mesh(sphere(0.03, 6), '#15191f', -0.1, 0.62, 0.16));
  // clipboard
  const cb = mesh(box(0.18, 0.24, 0.025), '#8b6a45', -0.3, 0.4, 0.1);
  cb.rotation.y = 0.25;
  group.add(cb);
  const paper = mesh(box(0.15, 0.2, 0.005), '#fff', -0.29, 0.41, 0.12);
  paper.rotation.y = 0.25;
  group.add(paper);
  const clip = mesh(box(0.07, 0.02, 0.025), '#a8acb4', -0.3, 0.51, 0.105);
  clip.rotation.y = 0.25;
  group.add(clip);
  // checklist lines
  for (let i = 0; i < 4; i++) {
    const ln = mesh(box(0.1, 0.008, 0.003), '#9ca2a8', -0.29, 0.46 - i * 0.035, 0.123);
    ln.rotation.y = 0.25;
    group.add(ln);
  }
  // green tick on first row
  const tick = mesh(box(0.02, 0.012, 0.003), '#3ec06a', -0.32, 0.46, 0.123);
  tick.rotation.y = 0.25;
  group.add(tick);
  return group;
}
