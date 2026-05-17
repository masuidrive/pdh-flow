import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  CAMERA_ANGLE_X,
  CAMERA_ANGLE_Y,
  CAMERA_DIST,
  CAMERA_FOLLOW_RATE,
  CAMERA_LOOK_Y_OFFSET,
  PIXELS_PER_WORLD_UNIT,
} from '@poly/config';

interface CameraFollowProps {
  targetZ: number;
}

/**
 * The camera locks the on-screen size of world objects to a constant
 * (set by PIXELS_PER_WORLD_UNIT in config) regardless of window size.
 * Resizing the browser changes how MUCH of the world is visible, but
 * never the apparent size of any individual character / station / orb.
 */
export function CameraFollow({ targetZ }: CameraFollowProps) {
  const focalRef = useRef(0);
  const { camera, size } = useThree();

  // Reconfigure the ortho frustum on canvas size changes.
  useEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return;
    // viewSize = half the world-height visible on screen. Setting it from
    // canvas pixel height pins the px-per-world-unit ratio.
    const viewSize = size.height / (2 * PIXELS_PER_WORLD_UNIT);
    const aspect = size.width / size.height;
    camera.left = -viewSize * aspect;
    camera.right = viewSize * aspect;
    camera.top = viewSize;
    camera.bottom = -viewSize;
    camera.near = -200;
    camera.far = 500;
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);

  useFrame((_, dt) => {
    const lerp = 1 - Math.exp(-dt * CAMERA_FOLLOW_RATE);
    const focal = focalRef.current + (targetZ - focalRef.current) * lerp;
    focalRef.current = focal;

    const r = CAMERA_DIST;
    camera.position.x = Math.sin(CAMERA_ANGLE_Y) * r * Math.cos(CAMERA_ANGLE_X);
    camera.position.y = CAMERA_LOOK_Y_OFFSET + Math.sin(CAMERA_ANGLE_X) * r;
    camera.position.z = focal + Math.cos(CAMERA_ANGLE_Y) * r * Math.cos(CAMERA_ANGLE_X);
    camera.lookAt(0, CAMERA_LOOK_Y_OFFSET, focal);
  });

  return null;
}
