/**
 * La simulacion es Z-arriba y la Web Audio API es Y-arriba. Equivocarse aqui no
 * rompe nada visible: simplemente los sonidos vienen del lado que no es, que es
 * justo el tipo de fallo que nadie detecta mirando el codigo.
 */

import { describe, expect, it } from 'vitest';

import { angleVectors, vec3 } from '@neonduel/shared';

import { listenerVectors, toAudioCoords } from '../src/spatial.js';

const cerca = (v: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

describe('coordenadas del audio', () => {
  it('el arriba del juego es el arriba del audio', () => {
    cerca(toAudioCoords(vec3(0, 0, 1)), 0, 1, 0);
  });

  it('el adelante del juego (+X) se conserva', () => {
    cerca(toAudioCoords(vec3(1, 0, 0)), 1, 0, 0);
  });

  it('la izquierda del juego (+Y) cae en -Z', () => {
    cerca(toAudioCoords(vec3(0, 1, 0)), 0, 0, -1);
  });

  it('conserva las distancias', () => {
    const v = vec3(3, -4, 12);
    const a = toAudioCoords(v);
    expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(Math.hypot(v.x, v.y, v.z), 9);
  });

  it('no invierte la mano: derecha por delante sigue dando arriba', () => {
    // Si la conversion reflejara en vez de girar, izquierda y derecha se
    // cambiarian y un disparo por la izquierda sonaria por la derecha.
    const { forward, right, up } = angleVectors(37, 11);
    const f = toAudioCoords(forward);
    const r = toAudioCoords(right);
    const u = toAudioCoords(up);
    const cruz = {
      x: r.y * f.z - r.z * f.y,
      y: r.z * f.x - r.x * f.z,
      z: r.x * f.y - r.y * f.x,
    };
    cerca(cruz, u.x, u.y, u.z);
  });
});

describe('orientacion del oyente', () => {
  it('mirando al frente y en horizontal mira a +X con Y arriba', () => {
    const { forward, up } = listenerVectors(0, 0);
    cerca(forward, 1, 0, 0);
    cerca(up, 0, 1, 0);
  });

  it('girar 90 grados pone el frente en -Z', () => {
    // yaw 90 mira a +Y en el juego, que es la izquierda; en audio, -Z.
    const { forward } = listenerVectors(90, 0);
    cerca(forward, 0, 0, -1);
  });

  it('el pitch positivo mira hacia abajo, como en la simulacion', () => {
    const { forward } = listenerVectors(0, 90);
    cerca(forward, 0, -1, 0);
  });

  it('frente y arriba siguen siendo perpendiculares y unitarios', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [45, 30],
      [-120, -75],
      [200, 12],
    ]) {
      const { forward, up } = listenerVectors(yaw!, pitch!);
      expect(dot(forward, up)).toBeCloseTo(0, 6);
      expect(Math.hypot(forward.x, forward.y, forward.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 6);
    }
  });
});
