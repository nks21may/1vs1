import { describe, expect, it } from 'vitest';

import { PLAYER_HEIGHT_DUCKED, PLAYER_HEIGHT_STANDING } from '../src/constants.js';
import {
  hasLineOfSight,
  playerHitboxes,
  shotDirection,
  traceHitscan,
} from '../src/hitscan.js';
import { vec3 } from '../src/math.js';
import { brush, flatWorld } from './helpers.js';

const world = flatWorld();
const target = { id: 2, pos: vec3(500, 0, 0), ducking: false };

/** Dispara desde la altura de los ojos hacia una altura concreta del objetivo. */
const shootAt = (targetZ: number, targets = [target], scene = world) => {
  const origin = vec3(0, 0, 64);
  const dir = vec3(500 - origin.x, 0, targetZ - origin.z);
  const len = Math.hypot(dir.x, dir.y, dir.z);
  return traceHitscan(
    scene,
    targets,
    origin,
    vec3(dir.x / len, dir.y / len, dir.z / len),
    8192,
  );
};

describe('playerHitboxes', () => {
  it('cubre toda la altura del jugador sin huecos', () => {
    const boxes = playerHitboxes({ id: 1, pos: vec3(0, 0, 0), ducking: false });
    const sorted = [...boxes].sort((a, b) => a.min.z - b.min.z);
    expect(sorted[0]!.min.z).toBe(0);
    expect(sorted[2]!.max.z).toBe(PLAYER_HEIGHT_STANDING);
    expect(sorted[0]!.max.z).toBe(sorted[1]!.min.z);
    expect(sorted[1]!.max.z).toBe(sorted[2]!.min.z);
  });

  it('agacharse encoge las hitboxes', () => {
    const ducked = playerHitboxes({ id: 1, pos: vec3(0, 0, 0), ducking: true });
    const top = Math.max(...ducked.map((b) => b.max.z));
    expect(top).toBe(PLAYER_HEIGHT_DUCKED);
  });

  it('la cabeza es mas estrecha que el torso', () => {
    const boxes = playerHitboxes({ id: 1, pos: vec3(0, 0, 0), ducking: false });
    const head = boxes.find((b) => b.hitGroup === 'head')!;
    const chest = boxes.find((b) => b.hitGroup === 'chest')!;
    expect(head.max.x - head.min.x).toBeLessThan(chest.max.x - chest.min.x);
  });
});

describe('traceHitscan', () => {
  it('acierta en la cabeza al apuntar arriba', () => {
    const result = shootAt(PLAYER_HEIGHT_STANDING - 4);
    expect(result.playerId).toBe(2);
    expect(result.hitGroup).toBe('head');
  });

  it('acierta en el torso al apuntar al centro', () => {
    const result = shootAt(45);
    expect(result.hitGroup).toBe('chest');
  });

  it('acierta en las piernas al apuntar abajo', () => {
    const result = shootAt(10);
    expect(result.hitGroup).toBe('legs');
  });

  it('una pared intermedia bloquea la bala', () => {
    const blocked = flatWorld([brush(200, -256, 0, 232, 256, 256)]);
    const result = shootAt(45, [target], blocked);
    expect(result.playerId).toBeNull();
    expect(result.hitWorld).toBe(true);
    expect(result.endPos.x).toBeCloseTo(200, 0);
  });

  it('dispara por encima de una cobertura baja', () => {
    const cover = flatWorld([brush(200, -256, 0, 232, 256, 40)]);
    const result = shootAt(64, [target], cover);
    expect(result.playerId).toBe(2);
  });

  it('un objetivo agachado se libra del disparo a la cabeza de pie', () => {
    const duckedTarget = { id: 2, pos: vec3(500, 0, 0), ducking: true };
    const result = shootAt(PLAYER_HEIGHT_STANDING - 4, [duckedTarget]);
    expect(result.playerId).toBeNull();
  });

  it('elige al objetivo mas cercano cuando hay dos alineados', () => {
    const near = { id: 3, pos: vec3(200, 0, 0), ducking: false };
    const result = shootAt(45, [target, near]);
    expect(result.playerId).toBe(3);
  });

  it('sin impacto la bala llega al alcance maximo', () => {
    const empty = { brushes: [], bounds: world.bounds };
    const result = traceHitscan(empty, [], vec3(0, 0, 64), vec3(1, 0, 0), 1000);
    expect(result.distance).toBeCloseTo(1000, 6);
    expect(result.playerId).toBeNull();
    expect(result.hitWorld).toBe(false);
  });

  it('el tirador no se dispara a si mismo si se excluye de los objetivos', () => {
    const result = traceHitscan(world, [], vec3(0, 0, 64), vec3(1, 0, 0), 1000);
    expect(result.playerId).toBeNull();
  });
});

describe('shotDirection', () => {
  it('coincide con el vector forward de la vista', () => {
    const dir = shotDirection(90, 0);
    expect(dir.y).toBeCloseTo(1, 9);
  });
});

describe('hasLineOfSight', () => {
  it('es true en campo abierto', () => {
    expect(hasLineOfSight(world, vec3(0, 0, 64), vec3(500, 0, 64))).toBe(true);
  });

  it('es false a traves de un muro', () => {
    const blocked = flatWorld([brush(200, -256, 0, 232, 256, 256)]);
    expect(hasLineOfSight(blocked, vec3(0, 0, 64), vec3(500, 0, 64))).toBe(false);
  });
});
