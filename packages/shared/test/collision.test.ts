import { describe, expect, it } from 'vitest';

import {
  DIST_EPSILON,
  clipVelocity,
  isPositionSolid,
  traceBox,
  traceRay,
} from '../src/collision.js';
import { vec3 } from '../src/math.js';
import { brush, flatWorld } from './helpers.js';

const mins = vec3(-16, -16, 0);
const maxs = vec3(16, 16, 72);

describe('traceRay', () => {
  const world = flatWorld([brush(100, -100, 0, 140, 100, 200)]);

  it('llega al final cuando no hay obstaculos', () => {
    const trace = traceRay(world, vec3(0, 0, 50), vec3(0, 0, 150));
    expect(trace.hit).toBe(false);
    expect(trace.fraction).toBe(1);
  });

  it('se detiene en la cara mas cercana con la normal correcta', () => {
    const trace = traceRay(world, vec3(0, 0, 50), vec3(300, 0, 50));
    expect(trace.hit).toBe(true);
    expect(trace.endPos.x).toBeCloseTo(100, 1);
    expect(trace.normal.x).toBe(-1);
  });

  it('devuelve el impacto mas cercano cuando hay varios brushes', () => {
    const twoWalls = flatWorld([
      brush(200, -100, 0, 240, 100, 200),
      brush(100, -100, 0, 140, 100, 200),
    ]);
    const trace = traceRay(twoWalls, vec3(0, 0, 50), vec3(400, 0, 50));
    expect(trace.endPos.x).toBeCloseTo(100, 1);
  });

  it('detecta la penetracion como startSolid', () => {
    const trace = traceRay(world, vec3(120, 0, 50), vec3(400, 0, 50));
    expect(trace.startSolid).toBe(true);
    expect(trace.fraction).toBe(0);
  });
});

describe('traceBox', () => {
  const world = flatWorld([brush(100, -100, 0, 140, 100, 200)]);

  it('choca antes que un rayo porque la caja tiene volumen', () => {
    const boxTrace = traceBox(world, vec3(0, 0, 1), vec3(300, 0, 1), mins, maxs);
    // 100 (pared) - 16 (media anchura) - epsilon de separacion.
    expect(boxTrace.endPos.x).toBeCloseTo(84 - DIST_EPSILON, 2);
  });

  it('deja siempre al jugador fuera del solido', () => {
    const trace = traceBox(world, vec3(0, 0, 1), vec3(300, 0, 1), mins, maxs);
    expect(isPositionSolid(world, trace.endPos, mins, maxs)).toBe(false);
  });

  it('apoyarse sobre una superficie no cuenta como penetracion', () => {
    // Origen exactamente sobre el suelo, movimiento puramente horizontal.
    const trace = traceBox(world, vec3(0, 0, 0), vec3(50, 0, 0), mins, maxs);
    expect(trace.startSolid).toBe(false);
    expect(trace.fraction).toBe(1);
  });

  it('detecta el suelo al trazar hacia abajo', () => {
    const trace = traceBox(world, vec3(0, 0, 40), vec3(0, 0, -10), mins, maxs);
    expect(trace.hit).toBe(true);
    expect(trace.normal.z).toBe(1);
    expect(trace.endPos.z).toBeGreaterThanOrEqual(0);
  });
});

describe('isPositionSolid', () => {
  const world = flatWorld([brush(100, -100, 0, 140, 100, 200)]);

  it('detecta solapamiento con un brush', () => {
    expect(isPositionSolid(world, vec3(120, 0, 10), mins, maxs)).toBe(true);
  });

  it('el espacio libre no es solido', () => {
    expect(isPositionSolid(world, vec3(0, 0, 10), mins, maxs)).toBe(false);
  });
});

describe('clipVelocity', () => {
  it('elimina la componente que entra en la superficie', () => {
    const clipped = clipVelocity(vec3(100, 0, -50), vec3(0, 0, 1));
    expect(clipped.z).toBeCloseTo(0, 6);
    expect(clipped.x).toBe(100);
  });

  it('conserva el movimiento paralelo a la pared', () => {
    const clipped = clipVelocity(vec3(-100, 200, 0), vec3(1, 0, 0));
    expect(clipped.x).toBeCloseTo(0, 6);
    expect(clipped.y).toBe(200);
  });
});
