import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { getCountTexture, getFailTexture } from '@poly/three/textures';

interface CountBadgeProps {
  count: number;
  failing: boolean;
  y?: number;
}

/**
 * Visit-count bubble. Hidden when count === 0 and not failing. When failing,
 * a red ✗ overrides the count number briefly.
 */
export function CountBadge({ count, failing, y = 1.15 }: CountBadgeProps) {
  const ref = useRef<THREE.Sprite>(null);

  useEffect(() => {
    const s = ref.current;
    if (!s) return;
    if (failing) {
      (s.material as THREE.SpriteMaterial).map = getFailTexture();
      s.visible = true;
    } else if (count > 0) {
      (s.material as THREE.SpriteMaterial).map = getCountTexture(count);
      s.visible = true;
    } else {
      s.visible = false;
    }
    (s.material as THREE.SpriteMaterial).needsUpdate = true;
  }, [count, failing]);

  return (
    <sprite ref={ref} position={[0, y, 0]} scale={[0.5, 0.5, 0.5]} renderOrder={20}>
      <spriteMaterial transparent depthTest={false} />
    </sprite>
  );
}
