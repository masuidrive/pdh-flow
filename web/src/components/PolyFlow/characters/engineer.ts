import * as THREE from 'three';
import { box } from '@poly/three/primitives';
import { mesh } from '@poly/three/materials';

/**
 * The engineer attaches limb refs the animation system reads via
 * `userData`. The new design exposes arms as `THREE.Group`s (not meshes)
 * because they pivot around the shoulder for the typing motion. `inner`
 * is exposed too in case the host wants to nudge the facing angle on
 * specific stages (e.g. different framing for `implement` vs `repair`).
 */
export interface EngineerData {
  armL: THREE.Group;
  armR: THREE.Group;
  head: THREE.Mesh;
  inner: THREE.Group;
}

/**
 * Engineer typing at a laptop. Body is angled 45° back toward the iso
 * camera; laptop sits in front at hand height with the screen facing
 * the typist; arms pivot at the shoulder so the typing animation
 * actually moves the hands over the keys.
 *
 * Anatomy lives inside an `inner` group whose Y rotation controls the
 * facing direction — that includes the laptop, so everything stays
 * spatially consistent if you change the angle.
 */
export function buildEngineer(): THREE.Group {
  const group = new THREE.Group();
  const body = '#3a5fa5';
  const skin = '#f4c89a';
  const pants = '#2f343f';
  const shoes = '#15191f';

  // --- Inner group: everything that should face the same direction --------
  const inner = new THREE.Group();

  // legs / shoes
  inner.add(mesh(box(0.13, 0.18, 0.13), pants, -0.08, 0.09, 0));
  inner.add(mesh(box(0.13, 0.18, 0.13), pants, 0.08, 0.09, 0));
  inner.add(mesh(box(0.15, 0.05, 0.19), shoes, -0.08, 0.025, 0.025));
  inner.add(mesh(box(0.15, 0.05, 0.19), shoes, 0.08, 0.025, 0.025));
  // torso
  inner.add(mesh(box(0.36, 0.32, 0.26), body, 0, 0.34, 0));
  // head — tilted down toward the screen
  const head = mesh(box(0.3, 0.3, 0.3), skin, 0, 0.65, 0);
  head.rotation.x = 0.18;
  inner.add(head);

  // Face accessories at +Z relative to inner. After inner's -π/2 + π/4
  // Y rotation they end up on the visible "face" side toward the camera.
  inner.add(mesh(box(0.32, 0.1, 0.32), '#3a2a1f', 0, 0.82, 0));          // hair
  inner.add(mesh(box(0.04, 0.05, 0.02), '#15191f', -0.07, 0.66, 0.151)); // eye L
  inner.add(mesh(box(0.04, 0.05, 0.02), '#15191f', 0.07, 0.66, 0.151));  // eye R
  // glasses
  inner.add(mesh(box(0.07, 0.07, 0.005), '#15191f', -0.07, 0.66, 0.155));
  inner.add(mesh(box(0.07, 0.07, 0.005), '#15191f', 0.07, 0.66, 0.155));
  inner.add(mesh(box(0.05, 0.01, 0.005), '#15191f', 0, 0.66, 0.155));

  // --- Arms: independent groups, pivoted at the shoulders ----------------
  // Each arm's origin is its shoulder. Rotating around X swings the
  // forearm — the typing motion. Both arms start forward (-1.2 rad)
  // so the hands rest on the keyboard.
  const armL = makeArm(-1, body, skin);
  const armR = makeArm(+1, body, skin);
  inner.add(armL);
  inner.add(armR);

  // --- Laptop: lives INSIDE inner so it rotates with the body ------------
  // Authored in the pre-rotation frame (+Z is "in front of" the character,
  // X is left-right of the body). Keyboard rows along X end up parallel
  // to the body axis after the inner rotation — which is correct for
  // someone facing along their forward direction.
  const laptop = buildLaptop();

  // y=0.40 aligns the keyboard with the engineer's hand tips at their
  // forward rest pose (arms at rotation.x = -1.2).
  laptop.position.set(0, 0.4, 0.32);
  // 180° spin so the screen faces the typist: the hinge ends up on the
  // far side of the keyboard and the trackpad sits closest to the chest,
  // as on a real laptop.
  laptop.rotation.y = Math.PI;
  inner.add(laptop);

  // Face direction: full side-on (-π/2) plus +45° back toward the
  // iso camera so the face is still visible.
  inner.rotation.y = -Math.PI / 2 + Math.PI / 4;
  group.add(inner);

  // Expose refs for the animation system in Worker.tsx.
  (group.userData as EngineerData).armL = armL;
  (group.userData as EngineerData).armR = armR;
  (group.userData as EngineerData).head = head;
  (group.userData as EngineerData).inner = inner;
  return group;
}

// =============================================================================
// Helpers
// =============================================================================

function makeArm(side: 1 | -1, bodyColor: string, skinColor: string): THREE.Group {
  const arm = new THREE.Group();
  // upper arm + hand, hanging from the shoulder origin
  arm.add(mesh(box(0.1, 0.22, 0.12), bodyColor, 0, -0.11, 0));
  arm.add(mesh(box(0.08, 0.06, 0.08), skinColor, 0, -0.25, 0.04));
  arm.position.set(side * 0.23, 0.46, 0);
  // Rest pose: arms reach forward (toward +Z in the inner frame).
  arm.rotation.x = -1.2;
  return arm;
}

function buildLaptop(): THREE.Group {
  const laptop = new THREE.Group();

  // Base / keyboard half
  laptop.add(mesh(box(0.32, 0.04, 0.24), '#34383f', 0, 0, 0));
  // Key rows (2 rows × 5 keys)
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 5; c++) {
      laptop.add(
        mesh(box(0.038, 0.005, 0.038), '#1a1d22',
          -0.115 + c * 0.057, 0.025, -0.06 + r * 0.06),
      );
    }
  }
  // Trackpad
  laptop.add(mesh(box(0.11, 0.005, 0.07), '#1a1d22', 0, 0.025, 0.07));

  // Screen half — hinged up at the back of the base
  const screen = new THREE.Group();
  screen.add(mesh(box(0.32, 0.21, 0.025), '#34383f', 0, 0.105, 0));
  screen.add(mesh(box(0.28, 0.17, 0.005), '#7fc4ea', 0, 0.105, 0.016));
  // Three code lines, each shorter than the last
  for (let i = 0; i < 3; i++) {
    screen.add(
      mesh(box(0.16 - i * 0.04, 0.012, 0.003), '#a8e6a8',
        -0.04 + i * 0.012, 0.155 - i * 0.04, 0.019),
    );
  }
  screen.position.set(0, 0.02, -0.12);
  screen.rotation.x = -0.55;
  laptop.add(screen);

  return laptop;
}
