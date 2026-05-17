import * as THREE from 'three';
import type { Stage } from '@poly/types';

// =============================================================================
// CanvasTexture factories. All sprites in the scene render text via Canvas2D
// because Three.js text geometry is heavy. These are baked once per
// (label, kind) and cached.
// =============================================================================

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeCanvasTexture(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  w: number,
  h: number,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Failed to acquire 2D context');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/** Pick the largest font (in given weight/family) that lets the text fit
 * within `maxWidth`. Falls back to `minPx` if even that doesn't fit. */
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startPx: number,
  minPx: number,
  weight: number,
  family: string,
): number {
  let px = startPx;
  while (px > minPx) {
    ctx.font = `${weight} ${px}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return px;
    px -= 2;
  }
  ctx.font = `${weight} ${minPx}px ${family}`;
  return minPx;
}

// --- Small nameplate (label only, auto-fitted) ------------------------------

export function makeLabelTexture(label: string): THREE.CanvasTexture {
  // Wide aspect (4.5:1) so even long yaml ids like
  // "code_quality_review__aggregator" can be displayed. Font scales down
  // automatically if the label exceeds the available width.
  const W = 720;
  const H = 160;
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#fff5d6';
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#2a3a4a';
    roundRect(ctx, 4, 4, W - 8, H - 8, 24);
    ctx.stroke();

    ctx.fillStyle = '#2a3a4a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, label, W - 80, 72, 32, 500, '"Fredoka", "Noto Sans JP", sans-serif');
    ctx.fillText(label, W / 2, H / 2);
  }, W, H);
}

// --- Active label card (bigger, more breathing room, auto-fitted) -----------

export function makeActiveInfoTexture(stage: Stage): THREE.CanvasTexture {
  // Same wide aspect as the inactive plate so the swap doesn't look
  // jarring. ~1.4× bigger overall with more interior padding. Label
  // only; no STEP indicator / sub-text / role chip.
  const W = 880;
  const H = 220;
  const label = stage.label || stage.id;
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#fff5d6';
    roundRect(ctx, 0, 0, W, H, 36);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#2a3a4a';
    roundRect(ctx, 5, 5, W - 10, H - 10, 32);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0e1418';
    fitFont(ctx, label, W - 140, 100, 44, 500, '"Fredoka", "Noto Sans JP", sans-serif');
    ctx.fillText(label, W / 2, H / 2);
  }, W, H);
}


// --- Role hover tooltip (sprite shown above a worker on pointer-over) ------

const roleTooltipCache = new Map<string, THREE.CanvasTexture>();

export function getRoleTooltipTexture(label: string): THREE.CanvasTexture {
  const cached = roleTooltipCache.get(label);
  if (cached) return cached;
  // Dark "speech-bubble" plate with a yellow text — visually distinct from
  // the cream-colored stage nameplates so it reads as transient UI rather
  // than another label.
  const W = 480;
  const H = 140;
  const tex = makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#2a3a4a';
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#fff5d6';
    roundRect(ctx, 3, 3, W - 6, H - 6, 26);
    ctx.stroke();
    ctx.fillStyle = '#ffd24a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, label, W - 60, 60, 28, 600, '"Fredoka", "Noto Sans JP", sans-serif');
    ctx.fillText(label, W / 2, H / 2);
  }, W, H);
  roleTooltipCache.set(label, tex);
  return tex;
}

// --- Count badge (number above worker head) ---------------------------------

const countCache = new Map<number, THREE.CanvasTexture>();

export function getCountTexture(n: number): THREE.CanvasTexture {
  const cached = countCache.get(n);
  if (cached) return cached;
  const tex = makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#ffd24a';
    ctx.beginPath();
    ctx.arc(64, 64, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#2a3a4a';
    ctx.stroke();
    ctx.fillStyle = '#2a3a4a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = n < 10 ? '800 80px "Manrope", sans-serif' : '800 60px "Manrope", sans-serif';
    ctx.fillText(String(n), 64, 68);
  }, 128, 128);
  countCache.set(n, tex);
  return tex;
}

// --- Failure badge (red ✗) ---------------------------------------------------

let failTexCache: THREE.CanvasTexture | null = null;

export function getFailTexture(): THREE.CanvasTexture {
  if (failTexCache) return failTexCache;
  failTexCache = makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#cc2222';
    ctx.beginPath();
    ctx.arc(64, 64, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#2a3a4a';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '700 82px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✗', 64, 70);
  }, 128, 128);
  return failTexCache;
}
