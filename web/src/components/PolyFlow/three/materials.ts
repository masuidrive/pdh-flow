import * as THREE from 'three';

// =============================================================================
// Materials are intentionally NOT cached globally. Each character / station /
// machine gets a fresh clone of its Lambert material so the color-wash system
// can mutate per-instance without bleeding across the scene.
//
// Each material is tagged with `userData.origColor` so `setGroupWash()` can
// restore the original on each frame before applying the new HSL desaturation.
// =============================================================================

export interface WashableMaterial extends THREE.MeshLambertMaterial {
  userData: {
    origColor?: THREE.Color;
    skipWash?: boolean;
  };
}

export function lambert(color: THREE.ColorRepresentation): WashableMaterial {
  const m = new THREE.MeshLambertMaterial({ color }) as WashableMaterial;
  m.userData = { origColor: new THREE.Color(color) };
  return m;
}

/**
 * Build a textured mesh with shadow casting enabled (the default for the
 * iso-style scene). Position is set directly so we don't need an
 * extra wrapper Group per mesh.
 */
export function mesh(
  geo: THREE.BufferGeometry,
  matOrColor: THREE.ColorRepresentation | WashableMaterial,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const material = typeof matOrColor === 'object' && 'isMaterial' in matOrColor
    ? matOrColor
    : lambert(matOrColor as THREE.ColorRepresentation);
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  m.position.set(x, y, z);
  return m;
}

/**
 * Walk a group and ensure every mesh has a unique, tagged material so its
 * color can be washed independently. Idempotent.
 */
export function tagForWash(group: THREE.Object3D): void {
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const mat = node.material;
    if (Array.isArray(mat) || !mat) return;
    if ((node.userData as { skipWash?: boolean }).skipWash) return;
    // Only Lambert materials with a `.color` participate.
    const lambertMat = mat as THREE.MeshLambertMaterial;
    if (!lambertMat.color) return;
    if (!(lambertMat.userData as { origColor?: THREE.Color }).origColor) {
      const cloned = lambertMat.clone() as WashableMaterial;
      cloned.userData = { origColor: lambertMat.color.clone() };
      node.material = cloned;
    }
  });
}

/**
 * Apply HSL desaturation + lightening to every washable mesh in a group.
 * amount=0 → full color, amount=1 → fully washed.
 */
export function setGroupWash(group: THREE.Object3D, amount: number): void {
  const a = Math.max(0, Math.min(1, amount));
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const mat = node.material;
    if (Array.isArray(mat) || !mat) return;
    if ((node.userData as { skipWash?: boolean }).skipWash) return;
    const lambertMat = mat as WashableMaterial;
    const orig = lambertMat.userData?.origColor;
    if (!orig) return;
    const c = lambertMat.color.copy(orig);
    const hsl: { h: number; s: number; l: number } = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    hsl.s *= 1 - a * 0.75;
    hsl.l = hsl.l + (0.85 - hsl.l) * a * 0.55;
    c.setHSL(hsl.h, hsl.s, hsl.l);
  });
}
