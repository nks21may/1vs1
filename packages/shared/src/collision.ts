/**
 * Colision de cajas alineadas a los ejes (AABB).
 *
 * El mundo es una lista de "brushes" AABB. Barrer la caja del jugador contra
 * ellos se reduce, via suma de Minkowski, a lanzar un rayo contra los brushes
 * expandidos por el tamano del jugador: es exacto, barato y determinista, que
 * es lo que necesitamos para que cliente y servidor coincidan bit a bit.
 */

import { type Vec3, clone, vec3 } from './math.js';

export interface Brush {
  readonly min: Vec3;
  readonly max: Vec3;
  /** Etiqueta de material: afecta al render y a los efectos de impacto. */
  readonly material?: string;
  /** Si es true bloquea el movimiento pero no las balas (no se usa aun). */
  readonly playerClip?: boolean;
}

export interface CollisionWorld {
  readonly brushes: readonly Brush[];
  /** Limites globales; salirse de ellos se trata como colision. */
  readonly bounds: { min: Vec3; max: Vec3 };
}

export interface TraceResult {
  /** Fraccion del recorrido completada en [0, 1]. */
  fraction: number;
  /** Posicion final segura. */
  endPos: Vec3;
  /** Normal de la superficie golpeada (nula si no hubo impacto). */
  normal: Vec3;
  /** True si el barrido choco con algo. */
  hit: boolean;
  /** True si el origen ya estaba dentro de un solido. */
  startSolid: boolean;
  /** Indice del brush golpeado, o -1. */
  brushIndex: number;
}

/** Separacion que se mantiene con las superficies para evitar quedar encajado. */
export const DIST_EPSILON = 0.03125;

const overlaps = (aMin: Vec3, aMax: Vec3, bMin: Vec3, bMax: Vec3): boolean =>
  aMin.x <= bMax.x &&
  aMax.x >= bMin.x &&
  aMin.y <= bMax.y &&
  aMax.y >= bMin.y &&
  aMin.z <= bMax.z &&
  aMax.z >= bMin.z;

const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];

interface SweepHit {
  fraction: number;
  normal: Vec3;
  startSolid: boolean;
}

/**
 * Barrido de un punto contra un AABB (ya expandido). Devuelve null si no toca.
 *
 * Sigue el esquema de Quake: la penetracion se detecta con una prueba de
 * contencion *estricta* (con margen `DIST_EPSILON`) y la fraccion de impacto se
 * retrasa ese mismo margen. Sin el margen, deslizar apoyado sobre una
 * superficie -- donde el origen queda exactamente en el plano del volumen
 * expandido -- se confundiria con estar dentro del solido y bloquearia al
 * jugador contra el suelo.
 */
const sweepPointVsBox = (
  start: Vec3,
  delta: Vec3,
  boxMin: Vec3,
  boxMax: Vec3,
  length: number,
): SweepHit | null => {
  // 1. Penetracion real: estrictamente dentro, sin contar el contacto tangente.
  let strictlyInside = true;
  for (const axis of AXES) {
    const s = start[axis];
    if (s <= boxMin[axis] + DIST_EPSILON || s >= boxMax[axis] - DIST_EPSILON) {
      strictlyInside = false;
      break;
    }
  }
  if (strictlyInside) return { fraction: 0, normal: vec3(), startSolid: true };

  // 2. Barrido por planos deslizantes contra el volumen exacto.
  let enter = -Infinity;
  let exit = Infinity;
  let enterAxis: Axis | null = null;
  let enterSign = 0;

  for (const axis of AXES) {
    const s = start[axis];
    const d = delta[axis];
    const lo = boxMin[axis];
    const hi = boxMax[axis];

    if (Math.abs(d) < 1e-9) {
      // Movimiento paralelo a las caras: o esta dentro del rango o no toca nunca.
      if (s < lo || s > hi) return null;
      continue;
    }

    let t1 = (lo - s) / d;
    let t2 = (hi - s) / d;
    let sign = -1; // entramos por la cara "min": la normal apunta a -eje
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > enter) {
      enter = t1;
      enterAxis = axis;
      enterSign = sign;
    }
    if (t2 < exit) exit = t2;
    if (enter > exit) return null;
  }

  // El origen esta en la superficie del volumen y el movimiento es tangencial o
  // de salida: no hay impacto que reportar.
  if (enter === -Infinity || enter < 0) return null;
  if (enter > 1 || exit < 0) return null;

  const normal = vec3();
  if (enterAxis) normal[enterAxis] = enterSign;

  // Detenerse `DIST_EPSILON` antes del contacto deja al jugador siempre fuera
  // del solido, que es lo que hace estable el apoyo tick tras tick.
  const backoff = length > 1e-9 ? DIST_EPSILON / length : 0;
  return {
    fraction: Math.max(0, enter - backoff),
    normal,
    startSolid: false,
  };
};

/**
 * Barre una caja (definida por `mins`/`maxs` relativos al origen) de `start` a `end`.
 */
export const traceBox = (
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
): TraceResult => {
  const delta = vec3(end.x - start.x, end.y - start.y, end.z - start.z);
  const deltaLength = Math.hypot(delta.x, delta.y, delta.z);

  let bestFraction = 1;
  let bestNormal = vec3();
  let bestIndex = -1;
  let hit = false;
  let startSolid = false;

  // AABB del jugador en el origen, usado para descartar brushes lejanos.
  const sweepMin = vec3(
    Math.min(start.x, end.x) + mins.x,
    Math.min(start.y, end.y) + mins.y,
    Math.min(start.z, end.z) + mins.z,
  );
  const sweepMax = vec3(
    Math.max(start.x, end.x) + maxs.x,
    Math.max(start.y, end.y) + maxs.y,
    Math.max(start.z, end.z) + maxs.z,
  );

  for (let i = 0; i < world.brushes.length; i++) {
    const brush = world.brushes[i]!;
    if (!overlaps(sweepMin, sweepMax, brush.min, brush.max)) continue;

    // Suma de Minkowski: expandimos el brush por el tamano del jugador.
    const expMin = vec3(brush.min.x - maxs.x, brush.min.y - maxs.y, brush.min.z - maxs.z);
    const expMax = vec3(brush.max.x - mins.x, brush.max.y - mins.y, brush.max.z - mins.z);

    const result = sweepPointVsBox(start, delta, expMin, expMax, deltaLength);
    if (!result) continue;

    if (result.startSolid) {
      startSolid = true;
      hit = true;
      bestFraction = 0;
      bestIndex = i;
      bestNormal = vec3();
      break;
    }

    if (result.fraction < bestFraction) {
      bestFraction = result.fraction;
      bestNormal = result.normal;
      bestIndex = i;
      hit = true;
    }
  }

  const endPos = startSolid
    ? clone(start)
    : vec3(
        start.x + delta.x * bestFraction,
        start.y + delta.y * bestFraction,
        start.z + delta.z * bestFraction,
      );

  return {
    fraction: bestFraction,
    endPos,
    normal: bestNormal,
    hit,
    startSolid,
    brushIndex: bestIndex,
  };
};

/** Barrido de un rayo puntual: usado por el hitscan contra la geometria. */
export const traceRay = (world: CollisionWorld, start: Vec3, end: Vec3): TraceResult =>
  traceBox(world, start, end, vec3(0, 0, 0), vec3(0, 0, 0));

/** True si la caja del jugador en `pos` solapa con algun brush. */
export const isPositionSolid = (
  world: CollisionWorld,
  pos: Vec3,
  mins: Vec3,
  maxs: Vec3,
): boolean => {
  const boxMin = vec3(pos.x + mins.x, pos.y + mins.y, pos.z + mins.z);
  const boxMax = vec3(pos.x + maxs.x, pos.y + maxs.y, pos.z + maxs.z);
  for (const brush of world.brushes) {
    if (overlaps(boxMin, boxMax, brush.min, brush.max)) return true;
  }
  return false;
};

/**
 * Proyecta `velocity` sobre el plano de `normal` para deslizar por la superficie.
 * `overbounce` > 1 despega ligeramente al jugador y evita re-colisiones inmediatas.
 */
export const clipVelocity = (velocity: Vec3, normal: Vec3, overbounce = 1.0): Vec3 => {
  const backoff =
    (velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z) * overbounce;
  return vec3(
    velocity.x - normal.x * backoff,
    velocity.y - normal.y * backoff,
    velocity.z - normal.z * backoff,
  );
};
