import { describe, expect, it } from 'vitest';

import {
  angleDelta,
  angleVectors,
  createRandom,
  hashSeed,
  lerpAngle,
  length,
  normalize,
  normalizeAngle,
  vec3,
} from '../src/math.js';

describe('normalize', () => {
  it('produce un vector unitario', () => {
    expect(length(normalize(vec3(3, 4, 0)))).toBeCloseTo(1, 9);
  });

  it('el vector nulo se queda en cero en lugar de dar NaN', () => {
    const result = normalize(vec3(0, 0, 0));
    expect(result).toEqual(vec3(0, 0, 0));
  });
});

describe('angulos', () => {
  it('normalizeAngle envuelve al rango [-180, 180)', () => {
    expect(normalizeAngle(190)).toBeCloseTo(-170, 9);
    expect(normalizeAngle(-190)).toBeCloseTo(170, 9);
    expect(normalizeAngle(720)).toBeCloseTo(0, 9);
  });

  it('angleDelta toma el camino corto a traves del salto de 180', () => {
    expect(angleDelta(170, -170)).toBeCloseTo(20, 9);
    expect(angleDelta(-170, 170)).toBeCloseTo(-20, 9);
  });

  it('lerpAngle no gira por el camino largo', () => {
    // El punto medio entre 170 y -170 es la antipoda: +-180 es el mismo angulo.
    expect(Math.abs(lerpAngle(170, -170, 0.5))).toBeCloseTo(180, 6);
    expect(lerpAngle(0, 90, 0.5)).toBeCloseTo(45, 6);
  });
});

describe('angleVectors', () => {
  it('yaw 0 mira hacia +X', () => {
    const { forward } = angleVectors(0, 0);
    expect(forward.x).toBeCloseTo(1, 9);
    expect(forward.y).toBeCloseTo(0, 9);
  });

  it('yaw 90 mira hacia +Y', () => {
    const { forward } = angleVectors(90, 0);
    expect(forward.y).toBeCloseTo(1, 9);
  });

  it('pitch positivo apunta hacia abajo', () => {
    const { forward } = angleVectors(0, 45);
    expect(forward.z).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('right es perpendicular a forward y horizontal', () => {
    const { forward, right } = angleVectors(37, 20);
    const dot = forward.x * right.x + forward.y * right.y + forward.z * right.z;
    expect(dot).toBeCloseTo(0, 9);
    expect(right.z).toBe(0);
  });
});

describe('createRandom', () => {
  it('es determinista para la misma semilla', () => {
    const a = createRandom(1234);
    const b = createRandom(1234);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('semillas distintas producen secuencias distintas', () => {
    const a = createRandom(1);
    const b = createRandom(2);
    expect(a()).not.toBe(b());
  });

  it('devuelve valores en [0, 1)', () => {
    const random = createRandom(99);
    for (let i = 0; i < 1000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  it('es estable y sensible al orden', () => {
    expect(hashSeed(1, 2, 3)).toBe(hashSeed(1, 2, 3));
    expect(hashSeed(1, 2, 3)).not.toBe(hashSeed(3, 2, 1));
  });

  it('devuelve un entero sin signo de 32 bits', () => {
    const seed = hashSeed(0xffffffff, 12345);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});
