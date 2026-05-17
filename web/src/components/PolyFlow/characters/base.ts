import * as THREE from 'three';
import { box, cyl, torus } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

// =============================================================================
// Character base — humanoid skeleton shared by most character builders.
// Returns refs to limbs so per-character animation hooks can find them.
// =============================================================================

export interface CharacterBaseRefs {
  group: THREE.Group;
  head: THREE.Mesh;
  torso: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
}

export interface CharacterBaseOptions {
  body?: string;
  skin?: string;
  pants?: string;
  shoes?: string;
}

export function characterBase({
  body = '#5a8acf',
  skin = '#f4c89a',
  pants = '#2a3a4a',
  shoes = '#1a1f25',
}: CharacterBaseOptions = {}): CharacterBaseRefs {
  const group = new THREE.Group();

  // legs
  group.add(mesh(box(0.13, 0.18, 0.13), pants, -0.08, 0.09, 0));
  group.add(mesh(box(0.13, 0.18, 0.13), pants, 0.08, 0.09, 0));
  // shoes
  group.add(mesh(box(0.15, 0.05, 0.19), shoes, -0.08, 0.025, 0.025));
  group.add(mesh(box(0.15, 0.05, 0.19), shoes, 0.08, 0.025, 0.025));
  // torso
  const torso = mesh(box(0.36, 0.32, 0.26), body, 0, 0.34, 0);
  group.add(torso);
  // arms
  const armL = mesh(box(0.1, 0.28, 0.12), body, -0.23, 0.34, 0);
  const armR = mesh(box(0.1, 0.28, 0.12), body, 0.23, 0.34, 0);
  group.add(armL);
  group.add(armR);
  // head
  const head = mesh(box(0.3, 0.3, 0.3), skin, 0, 0.65, 0);
  group.add(head);

  return { group, head, torso, armL, armR };
}

// --- Face accessories --------------------------------------------------------

export function addEyes(
  parent: THREE.Group,
  { color = '#1a1a1a', y = 0.66, sep = 0.07 }: { color?: string; y?: number; sep?: number } = {},
): void {
  parent.add(mesh(box(0.04, 0.05, 0.02), color, -sep, y, 0.151));
  parent.add(mesh(box(0.04, 0.05, 0.02), color, sep, y, 0.151));
}

export function addHair(parent: THREE.Group, color = '#3a2a1f'): void {
  parent.add(mesh(box(0.32, 0.1, 0.32), color, 0, 0.82, 0));
}

export function addGlasses(parent: THREE.Group, color = '#1a1a1a'): void {
  const l = mesh(torus(0.052, 0.012, 10, 4), color, -0.07, 0.66, 0.152);
  l.rotation.y = Math.PI / 2;
  parent.add(l);
  const r = mesh(torus(0.052, 0.012, 10, 4), color, 0.07, 0.66, 0.152);
  r.rotation.y = Math.PI / 2;
  parent.add(r);
  parent.add(mesh(box(0.05, 0.012, 0.012), color, 0, 0.66, 0.152));
}

export type MouthType = 'smile' | 'frown' | 'grin' | 'flat';

export function addMouth(
  parent: THREE.Group,
  { type = 'smile', y = 0.58 }: { type?: MouthType; y?: number } = {},
): void {
  if (type === 'smile') {
    parent.add(mesh(box(0.1, 0.018, 0.012), '#2a1a1a', 0, y, 0.151));
  } else if (type === 'frown') {
    parent.add(mesh(box(0.09, 0.018, 0.012), '#2a1a1a', 0, y, 0.151));
    parent.add(mesh(box(0.012, 0.018, 0.012), '#2a1a1a', -0.045, y - 0.018, 0.151));
    parent.add(mesh(box(0.012, 0.018, 0.012), '#2a1a1a', 0.045, y - 0.018, 0.151));
  } else if (type === 'grin') {
    parent.add(mesh(box(0.12, 0.022, 0.012), '#2a1a1a', 0, y, 0.151));
    parent.add(mesh(box(0.025, 0.022, 0.008), '#fff', 0.025, y, 0.156));
  } else if (type === 'flat') {
    parent.add(mesh(box(0.08, 0.014, 0.012), '#2a1a1a', 0, y, 0.151));
  }
}

// helper re-exports so character files only need to import this module
export { cyl };
