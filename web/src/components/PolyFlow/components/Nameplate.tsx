import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Stage } from '@poly/types';
import { makeActiveInfoTexture, makeLabelTexture } from '@poly/three/textures';
import {
  NAMEPLATE_BIG_SCALE,
  NAMEPLATE_HEIGHT,
  NAMEPLATE_OFFSET,
  NAMEPLATE_POSITION,
  NAMEPLATE_SMALL_SCALE,
} from '@poly/config';

interface NameplateProps {
  stage: Stage;
  active: boolean;
}

/**
 * Per-stage nameplate. Bottom-anchored so the active card grows upward
 * without overlapping the worker characters.
 */
export function Nameplate({ stage, active }: NameplateProps) {
  const spriteRef = useRef<THREE.Sprite>(null);

  // Show the yaml id as the label so the visualization aligns with the
  // flow definition. The door emoji marker is only used in the side
  // Timeline panel — on the 3D scene the gate's mesh itself communicates
  // the gate semantics, so we don't decorate the label here.
  const smallTex = useMemo(
    () => makeLabelTexture(stage.id),
    [stage.id],
  );
  const bigTex = useMemo(
    () => makeActiveInfoTexture({ ...stage, label: stage.id }),
    [stage],
  );

  // Swap texture + scale when active state changes.
  useEffect(() => {
    const s = spriteRef.current;
    if (!s) return;
    const mat = s.material as THREE.SpriteMaterial;
    if (active) {
      mat.map = bigTex;
      s.scale.set(NAMEPLATE_BIG_SCALE[0], NAMEPLATE_BIG_SCALE[1], 1);
      s.renderOrder = 30;
    } else {
      mat.map = smallTex;
      s.scale.set(NAMEPLATE_SMALL_SCALE[0], NAMEPLATE_SMALL_SCALE[1], 1);
      s.renderOrder = 10;
    }
    mat.needsUpdate = true;
  }, [active, bigTex, smallTex]);

  // Position relative to the station
  let position: [number, number, number];
  if (NAMEPLATE_POSITION === 'top' || NAMEPLATE_POSITION === 'none') {
    position = [0, 2.0, 0];
  } else {
    const sign = NAMEPLATE_POSITION === 'right' ? 1 : -1;
    position = [sign * (stage.radius + NAMEPLATE_OFFSET), NAMEPLATE_HEIGHT, 0];
  }

  if (NAMEPLATE_POSITION === 'none') return null;

  return (
    <sprite
      ref={spriteRef}
      position={position}
      center={new THREE.Vector2(0.5, 0)}      /* bottom-anchored */
      scale={[NAMEPLATE_SMALL_SCALE[0], NAMEPLATE_SMALL_SCALE[1], 1]}
    >
      <spriteMaterial map={smallTex} transparent depthTest={false} />
    </sprite>
  );
}
