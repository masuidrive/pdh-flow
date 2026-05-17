import * as THREE from 'three';
import type { CharacterKind } from '@poly/types';
import { tagForWash } from '@poly/three/materials';

import { buildPM } from './pm';
import { buildPlanner } from './planner';
import { buildDevilsAdvocate } from './devilsAdvocate';
import { buildEngineer } from './engineer';
import { buildCodeReviewer } from './codeReviewer';
import { buildCritical } from './critical';
import { buildAggregator } from './aggregator';
import { buildDoor } from './door';

export const CHAR_BUILDERS: Record<CharacterKind, () => THREE.Group> = {
  pm: buildPM,
  planner: buildPlanner,
  devils_advocate: buildDevilsAdvocate,
  engineer: buildEngineer,
  code_reviewer: buildCodeReviewer,
  critical: buildCritical,
  aggregator: buildAggregator,
  door: buildDoor,
};

export const CHAR_ORB_COLOR: Record<CharacterKind, string> = {
  pm: '#3d4655',
  planner: '#2e8b57',
  devils_advocate: '#ff5050',
  engineer: '#3a5fa5',
  code_reviewer: '#9b5fc0',
  critical: '#e07a2a',
  aggregator: '#ffd24a',
  door: '#7c5a35',
};

export const CHAR_DISPLAY_LABEL: Record<CharacterKind, string> = {
  pm: 'PM',
  planner: 'Planner',
  devils_advocate: "Devil's Advocate",
  engineer: 'Engineer',
  code_reviewer: 'Code Reviewer',
  critical: 'Critical',
  aggregator: 'Aggregator',
  door: 'Gate',
};

/**
 * Build a fresh character mesh-group for the given kind. Each call
 * yields a new tree with cloned, wash-tagged materials so per-instance
 * color manipulation doesn't leak across characters.
 */
export function buildCharacter(kind: CharacterKind): THREE.Group {
  const builder = CHAR_BUILDERS[kind];
  const g = builder();
  tagForWash(g);
  g.rotation.y = Math.PI / 4;
  return g;
}
