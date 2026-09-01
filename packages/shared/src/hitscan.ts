/**
 * Hitscan: resolucion de disparos contra la geometria y contra los jugadores.
 *
 * Las hitboxes se derivan siempre del mismo estado que usa la colision, de modo
 * que "lo que ves es donde disparas". El servidor las evalua sobre posiciones
 * rebobinadas (ver `lagcomp.ts`) para que el cliente acierte donde apunto.
 */

import {
  HEAD_HITBOX_BOTTOM,
  HITBOX_HALF_WIDTH,
  LEGS_HITBOX_TOP,
} from './constants.js';
import { type Brush, type CollisionWorld, traceRay } from './collision.js';
import { type Vec3, angleVectors, distance as dist, vec3 } from './math.js';
import { playerHeight } from './movement.js';
import type { HitGroup } from './weapons.js';

/** Media anchura de la cabeza: mas estrecha que el torso, premia la precision. */
export const HEAD_HALF_WIDTH = 12;

/** Instantanea minima de un jugador para calcular impactos. */
export interface HitboxSource {
  id: number;
  pos: Vec3;
  ducking: boolean;
}

interface HitboxBrush extends Brush {
  playerId: number;
  hitGroup: HitGroup;
}

/** Cajas de impacto (cabeza, torso, piernas) de un jugador. */
export const playerHitboxes = (player: HitboxSource): HitboxBrush[] => {
  const h = playerHeight(player.ducking);
  const { x, y, z } = player.pos;
  const headBottom = z + h * HEAD_HITBOX_BOTTOM;
  const legsTop = z + h * LEGS_HITBOX_TOP;

  return [
    {
      min: vec3(x - HEAD_HALF_WIDTH, y - HEAD_HALF_WIDTH, headBottom),
      max: vec3(x + HEAD_HALF_WIDTH, y + HEAD_HALF_WIDTH, z + h),
      playerId: player.id,
      hitGroup: 'head',
    },
    {
      min: vec3(x - HITBOX_HALF_WIDTH, y - HITBOX_HALF_WIDTH, legsTop),
      max: vec3(x + HITBOX_HALF_WIDTH, y + HITBOX_HALF_WIDTH, headBottom),
      playerId: player.id,
      hitGroup: 'chest',
    },
    {
      min: vec3(x - HITBOX_HALF_WIDTH, y - HITBOX_HALF_WIDTH, z),
      max: vec3(x + HITBOX_HALF_WIDTH, y + HITBOX_HALF_WIDTH, legsTop),
      playerId: player.id,
      hitGroup: 'legs',
    },
  ];
};

export interface HitscanResult {
  /** Punto donde termina la bala (impacto o alcance maximo). */
  endPos: Vec3;
  /** Distancia recorrida. */
  distance: number;
  /** Jugador alcanzado, si lo hay. */
  playerId: number | null;
  hitGroup: HitGroup | null;
  /** Normal de la superficie del mundo golpeada (para decals y chispas). */
  normal: Vec3;
  /** True si la bala choco contra la geometria en vez de contra el aire. */
  hitWorld: boolean;
}

/** Direccion unitaria de disparo a partir de los angulos de vista. */
export const shotDirection = (yaw: number, pitch: number): Vec3 =>
  angleVectors(yaw, pitch).forward;

/**
 * Lanza una bala desde `origin` en direccion `dir` (unitaria).
 * Gana el impacto mas cercano entre geometria y jugadores; asi las paredes
 * bloquean correctamente y no hay disparos a traves de cobertura.
 */
export const traceHitscan = (
  world: CollisionWorld,
  targets: readonly HitboxSource[],
  origin: Vec3,
  dir: Vec3,
  range: number,
): HitscanResult => {
  const end = vec3(
    origin.x + dir.x * range,
    origin.y + dir.y * range,
    origin.z + dir.z * range,
  );

  const worldTrace = traceRay(world, origin, end);
  let bestFraction = worldTrace.hit ? worldTrace.fraction : 1;
  let bestPlayer: number | null = null;
  let bestGroup: HitGroup | null = null;

  const hitboxes: HitboxBrush[] = [];
  for (const target of targets) hitboxes.push(...playerHitboxes(target));

  if (hitboxes.length > 0) {
    const hitboxWorld: CollisionWorld = { brushes: hitboxes, bounds: world.bounds };
    const playerTrace = traceRay(hitboxWorld, origin, end);
    if (
      playerTrace.hit &&
      !playerTrace.startSolid &&
      playerTrace.fraction <= bestFraction
    ) {
      const box = hitboxes[playerTrace.brushIndex];
      if (box) {
        bestFraction = playerTrace.fraction;
        bestPlayer = box.playerId;
        bestGroup = box.hitGroup;
      }
    }
  }

  const endPos = vec3(
    origin.x + (end.x - origin.x) * bestFraction,
    origin.y + (end.y - origin.y) * bestFraction,
    origin.z + (end.z - origin.z) * bestFraction,
  );

  return {
    endPos,
    distance: dist(origin, endPos),
    playerId: bestPlayer,
    hitGroup: bestGroup,
    normal: worldTrace.normal,
    hitWorld: bestPlayer === null && worldTrace.hit,
  };
};

/** True si hay linea de vision directa entre dos puntos (usado por el bot). */
export const hasLineOfSight = (
  world: CollisionWorld,
  from: Vec3,
  to: Vec3,
): boolean => !traceRay(world, from, to).hit;
