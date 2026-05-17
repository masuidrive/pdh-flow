import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { CharacterKind, Worker as WorkerData, WorkerStatus } from '@poly/types';
import { buildCharacter } from '@poly/characters';
import type { EngineerData } from '@poly/characters/engineer';
import type { DoorData } from '@poly/characters/door';
import { setGroupWash } from '@poly/three/materials';
import { getRoleTooltipTexture } from '@poly/three/textures';
import { useFlowStore } from '@poly/hooks/useFlowState';
import { CountBadge } from './CountBadge';

interface WorkerProps {
  data: WorkerData;
  status: WorkerStatus;
  wash: number;
  count: number;
  failing: boolean;
  phase: number;
  /** Whether this worker should show its role label on hover / tap. Only
   * enabled for parallel-stage reviewers where the role distinction
   * matters; on other stages the stage label already carries the role. */
  showRoleOnHover?: boolean;
}

const BASE_Y = 0.19;

/**
 * Renders a single character on a station pad. Animation is driven by status:
 *   - `work`  : bounce + lean (engineer types instead; door opens)
 *   - `done`  : fully still
 *   - `fail`  : head-shake (door rattles closed)
 *   - `idle`  : gentle bob
 *
 * The character mesh is built once per worker kind (memoized) and re-used
 * across re-renders. Color wash is re-applied whenever `wash` changes.
 */
export function Worker({
  data,
  status,
  wash,
  count,
  failing,
  phase,
  showRoleOnHover = false,
}: WorkerProps) {
  const groupRef = useRef<THREE.Group>(null);
  const charGroup = useMemo(() => buildCharacter(data.char), [data.char]);

  // --- Hover tooltip state -------------------------------------------------
  const [hovered, setHovered] = useState(false);
  const tooltipTex = useMemo(
    () => (showRoleOnHover ? getRoleTooltipTexture(data.label) : null),
    [showRoleOnHover, data.label],
  );
  // Defensive: clear hover state on stage change. r3f normally fires
  // pointerout when the mesh moves out from under the cursor (e.g. when
  // the camera slides during view nav), but this catches the edge case
  // where cursor and mesh happen to overlap at the new position too.
  const currentIdx = useFlowStore((s) => s.currentIdx);
  useEffect(() => {
    setHovered(false);
    if (typeof document !== 'undefined') document.body.style.cursor = '';
  }, [currentIdx]);
  // Ensure cursor resets if the component unmounts mid-hover.
  useEffect(() => () => {
    if (typeof document !== 'undefined') document.body.style.cursor = '';
  }, []);

  // Apply color wash whenever the wash level changes.
  useEffect(() => {
    setGroupWash(charGroup, wash);
  }, [charGroup, wash]);

  // Mount the character mesh into our ref group exactly once.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.add(charGroup);
    return () => {
      g.remove(charGroup);
    };
  }, [charGroup]);

  // Per-frame animation
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const g = groupRef.current;
    if (!g) return;
    animateWorker(charGroup, status, t, phase, data.char);
    // Bob the wrapper group, not the character, so character.position stays
    // free for the engineer's arm-based animation.
    let bob = 0;
    if (data.char === 'door') {
      bob = 0;
    } else if (status === 'work') {
      bob =
        data.char === 'engineer'
          ? Math.sin(t * 2 + phase) * 0.012
          : Math.abs(Math.sin(t * 5 + phase)) * 0.16;
    } else if (status === 'done' || status === 'fail') {
      bob = 0;
    } else {
      bob = Math.sin(t * 1.5 + phase) * 0.013;
    }
    g.position.y = BASE_Y + bob;
  });

  // Badge floats higher when worker is a door (taller mesh)
  const badgeY = data.char === 'door' ? 2.0 : 1.15;
  // Foot ring shows on the active worker; doors get the calmer style.
  const showRing = status === 'work';
  const bouncyRing = status === 'work' && data.char !== 'engineer' && data.char !== 'door';

  // Tooltip sits at the worker's feet — close to the ground, anchored
  // by its top edge so the bubble drops downward from y=0 rather than
  // overlapping the foot ring.
  const tooltipY = -0.05;

  return (
    <group
      ref={groupRef}
      position={[0, BASE_Y, 0]}
      onPointerOver={
        showRoleOnHover
          ? (e) => {
              e.stopPropagation();
              setHovered(true);
              document.body.style.cursor = 'pointer';
            }
          : undefined
      }
      onPointerOut={
        showRoleOnHover
          ? (e) => {
              e.stopPropagation();
              setHovered(false);
              document.body.style.cursor = '';
            }
          : undefined
      }
    >
      {showRing && <FootRing phase={phase} bouncy={bouncyRing} />}
      <CountBadge count={count} failing={failing} y={badgeY} />
      {hovered && tooltipTex && (
        <sprite
          position={[0, tooltipY, 0]}
          // top-anchored: the sprite hangs down from `position`, so the
          // bubble appears below the worker's feet without overlapping
          // the character.
          center={new THREE.Vector2(0.5, 1)}
          scale={[1.8, 0.55, 1]}
          renderOrder={40}
        >
          <spriteMaterial
            map={tooltipTex}
            transparent
            depthTest={false}
            depthWrite={false}
          />
        </sprite>
      )}
    </group>
  );
}

// =============================================================================
// Animation switches — kept as a free function so we can unit-test it later.
// =============================================================================

function animateWorker(
  char: THREE.Group,
  status: WorkerStatus,
  t: number,
  phase: number,
  kind: CharacterKind,
): void {
  if (kind === 'door') {
    animateDoor(char as THREE.Group & { userData: Partial<DoorData> }, status, t, phase);
    return;
  }
  const userData = char.userData as Partial<EngineerData>;
  const armL = userData.armL;
  const armR = userData.armR;

  if (status === 'work') {
    if (kind === 'engineer') {
      char.rotation.z = Math.sin(t * 2 + phase) * 0.02;
      char.rotation.x = 0;
      // Arms tap around their forward rest pose (-1.2 rad). Tighter
      // amplitude than before because the side-on view makes even
      // small swings read clearly.
      if (armL) armL.rotation.x = -1.2 + Math.sin(t * 16 + phase) * 0.12;
      if (armR) armR.rotation.x = -1.2 + Math.sin(t * 16 + phase + Math.PI) * 0.12;
    } else {
      char.rotation.z = Math.sin(t * 5 + phase) * 0.10;
      char.rotation.x = Math.sin(t * 5 + phase + 0.4) * 0.08;
    }
  } else if (status === 'fail') {
    char.rotation.z = Math.sin(t * 18 + phase) * 0.18;
    char.rotation.x = 0;
    // Hands stay on the keyboard in all states; only the typing
    // oscillation stops in non-work states.
    if (armL) armL.rotation.x = -1.2;
    if (armR) armR.rotation.x = -1.2;
  } else {
    char.rotation.z = 0;
    char.rotation.x = 0;
    if (armL) armL.rotation.x = -1.2;
    if (armR) armR.rotation.x = -1.2;
  }
}

function animateDoor(
  door: THREE.Group & { userData: Partial<DoorData> },
  status: WorkerStatus,
  t: number,
  phase: number,
): void {
  const hinge = door.userData.hinge;
  if (!hinge) return;
  let target = 0;     // closed
  let extra = 0;      // sway / rattle
  if (status === 'work') {
    target = -Math.PI / 3;
    extra = Math.sin(t * 3 + phase) * 0.08;
  } else if (status === 'done') {
    target = -Math.PI / 3;
  } else if (status === 'fail') {
    target = 0;
    extra = Math.sin(t * 18 + phase) * 0.1;
  }
  hinge.rotation.y += (target - hinge.rotation.y) * 0.15 + extra;
  door.rotation.z = 0;
  door.rotation.x = 0;
}

// =============================================================================
// Foot ring (pulses around active worker's feet)
// =============================================================================

function FootRing({ phase, bouncy }: { phase: number; bouncy: boolean }) {
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const mesh = ringRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    if (bouncy) {
      mat.opacity = 0.55 + Math.sin(t * 6 + phase) * 0.35;
      const s = 1 + Math.sin(t * 4 + phase) * 0.15;
      mesh.scale.set(s, 1, s);
    } else {
      mat.opacity = 0.4 + Math.sin(t * 5 + phase) * 0.2;
      mesh.scale.set(1, 1, 1);
    }
  });

  return (
    <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
      <ringGeometry args={[0.32, 0.52, 24]} />
      <meshBasicMaterial
        color={'#ffd24a'}
        side={THREE.DoubleSide}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}
