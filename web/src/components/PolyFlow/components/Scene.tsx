import { useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { CameraFollow } from './CameraFollow';
import { Corridor } from './Corridor';
import { StationGroup } from './StationGroup';
import { useFlowStore } from '@poly/hooks/useFlowState';
import { useOrbs, type OrbController } from '@poly/hooks/useOrbs';

interface SceneProps {
  /** The Z that the camera should focus on. Computed by PolyFlow from
   * `currentIdx + viewOffset` so the user's camera-only nav buttons can
   * shift focus without advancing flow state. */
  targetZ: number;
  /** Mounted into the scene; receives the orb controller after first render. */
  onOrbControllerReady?(c: OrbController): void;
}

export function Scene({ targetZ, onOrbControllerReady }: SceneProps) {
  const stages = useFlowStore((s) => s.stages);
  const currentIdx = useFlowStore((s) => s.currentIdx);
  const visitCounts = useFlowStore((s) => s.visitCounts);
  const failingStageId = useFlowStore((s) => s.failingStageId);

  return (
    <Canvas
      orthographic
      camera={{ position: [18, 22, 18], zoom: 1 }}
      shadows
      gl={{ antialias: true }}
    >
      <color attach="background" args={['#fef7e0']} />
      <fog attach="fog" args={['#fef7e0', 28, 60]} />
      <ambientLight intensity={0.55} color={'#fff5d6'} />
      <directionalLight
        position={[8, 22, 12]}
        intensity={0.95}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-camera-near={1}
        shadow-camera-far={80}
        shadow-bias={-0.0008}
      />
      <directionalLight position={[-10, 8, -8]} intensity={0.18} color={'#a8c4e0'} />

      <CameraFollow targetZ={targetZ} />
      <Corridor stages={stages} />

      {stages.map((stage, i) => (
        <StationGroup
          key={stage.id}
          stage={stage}
          idx={i}
          isActive={i === currentIdx}
          isPast={i < currentIdx}
          visitCount={visitCounts[stage.id] ?? 0}
          failingStageId={failingStageId}
        />
      ))}

      <OrbLayer onReady={onOrbControllerReady} />
    </Canvas>
  );
}

// =============================================================================
// OrbLayer must live inside <Canvas/> to access useFrame.
// =============================================================================

interface OrbLayerProps {
  onReady?: (c: OrbController) => void;
}

function OrbLayer({ onReady }: OrbLayerProps) {
  const rootRef = useRef<THREE.Group>(null);
  const controller = useOrbs(rootRef);
  // Bubble the controller up to PolyFlow.tsx after first render.
  useEffect(() => {
    if (onReady) onReady(controller);
  }, [onReady, controller]);
  return <group ref={rootRef} />;
}
