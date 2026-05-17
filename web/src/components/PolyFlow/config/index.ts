// =============================================================================
// Design knobs — every tweakable visual constant in one place.
// =============================================================================

// --- Camera ------------------------------------------------------------------

/** Yaw (world-y rotation), radians. 45° is standard isometric. */
export const CAMERA_ANGLE_Y = Math.PI / 4;

/** Pitch (world-x rotation), radians. */
export const CAMERA_ANGLE_X = (25 * Math.PI) / 180;

/** Distance from focal point. Doesn't affect ortho zoom (use VIEW_SIZE). */
export const CAMERA_DIST = 28;

/**
 * How many screen pixels correspond to one world unit. This pins the
 * on-screen size of every character / station / orb so that resizing the
 * browser changes how much of the corridor is visible but NEVER changes
 * the apparent size of anything in it.
 *
 * Higher = bigger characters on screen (less of the world visible).
 * Lower  = smaller characters (more of the world visible).
 */
export const PIXELS_PER_WORLD_UNIT = 42;

/**
 * Vertical offset (world units) added to the camera's lookAt Y. The
 * camera otherwise centers on Y=0 (the station pad), which puts the
 * characters in the middle of the panel — and once the panel sits
 * under the heavier 3D RunStatusCard the upper screen edge feels
 * cramped. Pushing lookAt up by ~1.5 units biases the subject toward
 * the lower half of the panel and clears the top.
 */
export const CAMERA_LOOK_Y_OFFSET = 1.5;

/** Camera focal Z lerp rate (higher = snappier follow). */
export const CAMERA_FOLLOW_RATE = 3.2;

// --- Layout ------------------------------------------------------------------

/** Distance between consecutive stations along the corridor (Z axis). */
export const Z_STEP = 6.5;

/** Width of the corridor floor strip. */
export const CORRIDOR_WIDTH = 14;

// --- Nameplates --------------------------------------------------------------

export type NameplatePosition = 'top' | 'left' | 'right' | 'none';

export const NAMEPLATE_POSITION: NameplatePosition = 'top';
export const NAMEPLATE_OFFSET = 1.5;
export const NAMEPLATE_HEIGHT = 1.5;

/** Sprite size for inactive nameplates [width, height]. */
/** Sprite size for the inactive stage nameplate. Wide aspect to fit long
 * yaml ids like "code_quality_review__aggregator" without clipping. */
export const NAMEPLATE_SMALL_SCALE: [number, number] = [3.0, 0.67];

/** Sprite size for the active stage's focused label card. ~1.4× the
 * inactive plate, with extra interior padding. */
export const NAMEPLATE_BIG_SCALE: [number, number] = [3.8, 0.95];

// --- Color wash (HSL desaturation) ------------------------------------------
// Opacity is intentionally avoided for state fade because Three.js transparent
// materials have z-fighting and shadow issues with low-poly meshes.

export const WASH_ACTIVE = 0;     // full color
export const WASH_PAST = 0.62;    // washed but visible
export const WASH_FUTURE = 0.78;  // more washed (upcoming work)

// --- Drag-scrub --------------------------------------------------------------

/** Pixels of horizontal drag to advance one stage in the carousel. */
export const PX_PER_STAGE = 160;

// --- Defaults ----------------------------------------------------------------

/** Character used when a yaml role has no mapping in `characters:`. */
export const DEFAULT_CHARACTER = 'pm' as const;

/** Probability that an auto-play step will fail a fail-capable stage. */
export const AUTO_FAIL_PROBABILITY = 0.18;

// --- Mobile breakpoint -------------------------------------------------------

export const MOBILE_BREAKPOINT_PX = 700;
