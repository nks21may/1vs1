/**
 * El mapa se genera por codigo, asi que estos tests actuan de "compilador":
 * verifican que la arena es simetrica, jugable y sin trampas geometricas.
 */

import { describe, expect, it } from 'vitest';

import { ATRIUM, ATRIUM_WORLD, mirrorBrushX } from '../src/map.js';
import { isPositionSolid, traceRay } from '../src/collision.js';
import { BUTTON, TICK_DT } from '../src/constants.js';
import { vec3 } from '../src/math.js';
import { createMoveState, moveStep, playerMaxs, playerMins } from '../src/movement.js';

const key = (b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) =>
  `${b.min.x},${b.min.y},${b.min.z},${b.max.x},${b.max.y},${b.max.z}`;

describe('geometria del mapa', () => {
  it('tiene brushes y un nombre', () => {
    expect(ATRIUM.name).toBe('ATRIUM');
    expect(ATRIUM.brushes.length).toBeGreaterThan(10);
  });

  it('todos los brushes tienen volumen positivo', () => {
    for (const brush of ATRIUM.brushes) {
      expect(brush.max.x).toBeGreaterThan(brush.min.x);
      expect(brush.max.y).toBeGreaterThan(brush.min.y);
      expect(brush.max.z).toBeGreaterThan(brush.min.z);
    }
  });

  it('es exactamente simetrico respecto al eje X', () => {
    const keys = new Set(ATRIUM.brushes.map(key));
    for (const brush of ATRIUM.brushes) {
      expect(keys.has(key(mirrorBrushX(brush)))).toBe(true);
    }
  });

  it('la geometria cabe dentro de los limites declarados', () => {
    for (const brush of ATRIUM.brushes) {
      expect(brush.min.x).toBeGreaterThanOrEqual(ATRIUM.bounds.min.x);
      expect(brush.max.x).toBeLessThanOrEqual(ATRIUM.bounds.max.x);
      expect(brush.min.y).toBeGreaterThanOrEqual(ATRIUM.bounds.min.y);
      expect(brush.max.y).toBeLessThanOrEqual(ATRIUM.bounds.max.y);
    }
  });
});

describe('spawns', () => {
  it('son dos y estan enfrentados', () => {
    const [a, b] = ATRIUM.spawns;
    expect(a.pos.x).toBeCloseTo(-b.pos.x, 6);
    expect(a.pos.y).toBeCloseTo(b.pos.y, 6);
    expect(Math.abs(a.yaw - b.yaw)).toBe(180);
  });

  it('no estan dentro de la geometria', () => {
    for (const spawn of ATRIUM.spawns) {
      expect(
        isPositionSolid(ATRIUM_WORLD, spawn.pos, playerMins(), playerMaxs(false)),
      ).toBe(false);
    }
  });

  it('el jugador aterriza en suelo firme al aparecer', () => {
    for (const spawn of ATRIUM.spawns) {
      const state = createMoveState(spawn.pos, spawn.yaw);
      for (let i = 0; i < 128; i++) {
        moveStep(state, { seq: i, buttons: 0, yaw: spawn.yaw, pitch: 0, dt: TICK_DT }, ATRIUM_WORLD);
      }
      expect(state.onGround).toBe(true);
      expect(state.pos.z).toBeGreaterThan(ATRIUM.killZ);
    }
  });

  it('no hay linea de tiro directa entre spawns', () => {
    const [a, b] = ATRIUM.spawns;
    const eyeA = vec3(a.pos.x, a.pos.y, a.pos.z + 64);
    const eyeB = vec3(b.pos.x, b.pos.y, b.pos.z + 64);
    expect(traceRay(ATRIUM_WORLD, eyeA, eyeB).hit).toBe(true);
  });
});

describe('jugabilidad', () => {
  /** Camina `ticks` ticks en la direccion `yaw` desde `pos`. */
  const walk = (pos: { x: number; y: number; z: number }, yaw: number, ticks: number) => {
    const state = createMoveState(vec3(pos.x, pos.y, pos.z), yaw);
    // Unos ticks en reposo para aterrizar antes de empezar a andar.
    for (let i = 0; i < 64; i++) {
      moveStep(state, { seq: i, buttons: 0, yaw, pitch: 0, dt: TICK_DT }, ATRIUM_WORLD);
    }
    for (let i = 0; i < ticks; i++) {
      moveStep(
        state,
        { seq: i, buttons: BUTTON.FORWARD, yaw, pitch: 0, dt: TICK_DT },
        ATRIUM_WORLD,
      );
    }
    return state;
  };

  it('se puede bajar del spawn y llegar al centro rodeando la cobertura', () => {
    const [spawn] = ATRIUM.spawns;
    // En diagonal: el camino recto lo corta una caja de cobertura a proposito.
    const state = walk(spawn.pos, 35, 320);
    expect(state.pos.x).toBeGreaterThan(-500);
    expect(state.onGround).toBe(true);
  });

  it('las escaleras a los balcones se suben caminando, sin saltar', () => {
    // Se sale desde la rampa del spawn, que es donde arranca la escalera.
    const state = walk({ x: -820, y: 100, z: 60 }, 90, 256);
    expect(state.pos.z).toBeCloseTo(128, 0);
    expect(state.pos.y).toBeGreaterThan(448);
    expect(state.onGround).toBe(true);
  });

  it('la rampa del spawn se sube de vuelta caminando', () => {
    const state = walk({ x: -700, y: 0, z: 8 }, 180, 256);
    expect(state.pos.z).toBeCloseTo(96, 0);
    expect(state.pos.x).toBeLessThan(-960);
  });

  it('los muros perimetrales encierran la arena', () => {
    const state = createMoveState(vec3(-1024, 0, 200), 180);
    for (let i = 0; i < 400; i++) {
      moveStep(
        state,
        { seq: i, buttons: BUTTON.FORWARD, yaw: 180, pitch: 0, dt: TICK_DT },
        ATRIUM_WORLD,
      );
    }
    expect(state.pos.x).toBeGreaterThan(ATRIUM.bounds.min.x);
  });
});
