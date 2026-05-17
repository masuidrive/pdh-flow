import * as THREE from 'three';

// =============================================================================
// Cached geometry primitives. Identical-shape boxes / cylinders / etc. share
// the same BufferGeometry to keep memory low (we build ~200 meshes per scene).
// =============================================================================

const geoCache = new Map<string, THREE.BufferGeometry>();

export function box(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `b${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)}`;
  const cached = geoCache.get(key);
  if (cached) return cached as THREE.BoxGeometry;
  const geo = new THREE.BoxGeometry(w, h, d);
  geoCache.set(key, geo);
  return geo;
}

export function sphere(r: number, segs = 10): THREE.SphereGeometry {
  const key = `s${r.toFixed(3)},${segs}`;
  const cached = geoCache.get(key);
  if (cached) return cached as THREE.SphereGeometry;
  const geo = new THREE.SphereGeometry(r, segs, segs);
  geoCache.set(key, geo);
  return geo;
}

export function cyl(
  rt: number,
  rb: number,
  h: number,
  segs = 10,
): THREE.CylinderGeometry {
  const key = `c${rt.toFixed(3)},${rb.toFixed(3)},${h.toFixed(3)},${segs}`;
  const cached = geoCache.get(key);
  if (cached) return cached as THREE.CylinderGeometry;
  const geo = new THREE.CylinderGeometry(rt, rb, h, segs);
  geoCache.set(key, geo);
  return geo;
}

export function cone(r: number, h: number, segs = 8): THREE.ConeGeometry {
  const key = `co${r.toFixed(3)},${h.toFixed(3)},${segs}`;
  const cached = geoCache.get(key);
  if (cached) return cached as THREE.ConeGeometry;
  const geo = new THREE.ConeGeometry(r, h, segs);
  geoCache.set(key, geo);
  return geo;
}

export function torus(
  r: number,
  tr: number,
  segs = 12,
  tsegs = 6,
): THREE.TorusGeometry {
  const key = `t${r.toFixed(3)},${tr.toFixed(3)},${segs},${tsegs}`;
  const cached = geoCache.get(key);
  if (cached) return cached as THREE.TorusGeometry;
  const geo = new THREE.TorusGeometry(r, tr, tsegs, segs);
  geoCache.set(key, geo);
  return geo;
}
