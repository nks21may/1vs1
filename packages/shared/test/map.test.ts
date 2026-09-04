/**
 * El mapa se genera por codigo, asi que estos tests actuan de "compilador":
 * verifican que la arena es simetrica, jugable y sin trampas geometricas.
 */

import { describe, expect, it } from 'vitest';

import { ATRIUM, ATRIUM_WORLD, CONDUIT, MAPS, createCollisionWorld, mirrorBrushX } from '../src/map.js';
import { isPositionSolid, traceRay } from '../src/collision.js';
import { BUTTON, TICK_DT } from '../src/constants.js';
import { vec3 } from '../src/math.js';
import { createMoveState, moveStep, playerMaxs, playerMins } from '../src/movement.js';

const key = (b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) =>
  `${b.min.x},${b.min.y},${b.min.z},${b.max.x},${b.max.y},${b.max.z}`;

/**
 * Los invariantes se comprueban sobre TODOS los mapas: son las reglas que
 * cualquier arena tiene que cumplir para ser jugable, y un mapa nuevo que las
 * incumpla tiene que romper la bateria el dia que se anade, no el dia que
 * alguien se cae por un agujero.
 */
describe.each(Object.entries(MAPS))('invariantes de %s', (nombre, mapa) => {
  const world = createCollisionWorld(mapa);

  it('tiene brushes y se llama como su clave', () => {
    expect(mapa.name).toBe(nombre);
    expect(mapa.brushes.length).toBeGreaterThan(10);
  });

  it('todos los brushes tienen volumen positivo', () => {
    for (const brush of mapa.brushes) {
      expect(brush.max.x).toBeGreaterThan(brush.min.x);
      expect(brush.max.y).toBeGreaterThan(brush.min.y);
      expect(brush.max.z).toBeGreaterThan(brush.min.z);
    }
  });

  it('es exactamente simetrico respecto al eje X', () => {
    const keys = new Set(mapa.brushes.map(key));
    for (const brush of mapa.brushes) {
      expect(keys.has(key(mirrorBrushX(brush)))).toBe(true);
    }
  });

  it('la geometria cabe dentro de los limites declarados', () => {
    for (const brush of mapa.brushes) {
      expect(brush.min.x).toBeGreaterThanOrEqual(mapa.bounds.min.x);
      expect(brush.max.x).toBeLessThanOrEqual(mapa.bounds.max.x);
      expect(brush.min.y).toBeGreaterThanOrEqual(mapa.bounds.min.y);
      expect(brush.max.y).toBeLessThanOrEqual(mapa.bounds.max.y);
    }
  });

  it('los spawns son dos y estan enfrentados', () => {
    const [a, b] = mapa.spawns;
    expect(a.pos.x).toBeCloseTo(-b.pos.x, 6);
    expect(a.pos.y).toBeCloseTo(b.pos.y, 6);
    expect(Math.abs(a.yaw - b.yaw)).toBe(180);
  });

  it('los spawns no estan dentro de la geometria', () => {
    for (const spawn of mapa.spawns) {
      expect(isPositionSolid(world, spawn.pos, playerMins(), playerMaxs(false))).toBe(false);
    }
  });

  it('el jugador aterriza en suelo firme al aparecer', () => {
    for (const spawn of mapa.spawns) {
      const state = createMoveState(spawn.pos, spawn.yaw);
      for (let i = 0; i < 128; i++) {
        moveStep(state, { seq: i, buttons: 0, yaw: spawn.yaw, pitch: 0, dt: TICK_DT }, world);
      }
      expect(state.onGround).toBe(true);
      expect(state.pos.z).toBeGreaterThan(mapa.killZ);
    }
  });

  it('no hay linea de tiro directa entre spawns', () => {
    const [a, b] = mapa.spawns;
    const eyeA = vec3(a.pos.x, a.pos.y, a.pos.z + 64);
    const eyeB = vec3(b.pos.x, b.pos.y, b.pos.z + 64);
    expect(traceRay(world, eyeA, eyeB).hit).toBe(true);
  });

  it('los muros perimetrales encierran la arena', () => {
    for (const yaw of [0, 90, 180, 270]) {
      const [spawn] = mapa.spawns;
      const state = createMoveState(vec3(spawn.pos.x, spawn.pos.y, spawn.pos.z), yaw);
      for (let i = 0; i < 600; i++) {
        moveStep(state, { seq: i, buttons: BUTTON.FORWARD, yaw, pitch: 0, dt: TICK_DT }, world);
      }
      expect(state.pos.x).toBeGreaterThan(mapa.bounds.min.x);
      expect(state.pos.x).toBeLessThan(mapa.bounds.max.x);
      expect(state.pos.y).toBeGreaterThan(mapa.bounds.min.y);
      expect(state.pos.y).toBeLessThan(mapa.bounds.max.y);
      expect(state.pos.z).toBeGreaterThan(mapa.killZ);
    }
  });
});

describe('jugabilidad de ATRIUM', () => {
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
});

describe('jugabilidad de CONDUIT', () => {
  const world = createCollisionWorld(CONDUIT);

  /**
   * CONDUIT es plano, asi que "se puede llegar" se comprueba de verdad: una
   * busqueda en anchura sobre una rejilla de posiciones donde el jugador cabe.
   * Un camino escrito a mano solo probaria el camino que se escribio.
   */
  const alcanzables = () => {
    const PASO = 32;
    const z = 8;
    const cabe = (x: number, y: number) =>
      !isPositionSolid(world, vec3(x, y, z), playerMins(), playerMaxs(false));

    const clave = (x: number, y: number) => `${x},${y}`;
    const inicio = CONDUIT.spawns[0].pos;
    const desde: [number, number] = [
      Math.round(inicio.x / PASO) * PASO,
      Math.round(inicio.y / PASO) * PASO,
    ];

    const vistos = new Set<string>([clave(...desde)]);
    const cola: [number, number][] = [desde];
    while (cola.length > 0) {
      const [x, y] = cola.shift()!;
      for (const [dx, dy] of [
        [PASO, 0],
        [-PASO, 0],
        [0, PASO],
        [0, -PASO],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (Math.abs(nx) > 1152 || Math.abs(ny) > 768) continue;
        const k = clave(nx, ny);
        if (vistos.has(k) || !cabe(nx, ny)) continue;
        vistos.add(k);
        cola.push([nx, ny]);
      }
    }
    return vistos;
  };

  it('se puede ir andando de un spawn al otro', () => {
    const vistos = alcanzables();
    const destino = CONDUIT.spawns[1].pos;
    const k = `${Math.round(destino.x / 32) * 32},${Math.round(destino.y / 32) * 32}`;
    expect(vistos.has(k)).toBe(true);
  });

  it('los tres carriles se comunican: se llega a los dos pasillos', () => {
    const vistos = alcanzables();
    // Un punto bien dentro de cada pasillo lateral, en la mitad contraria.
    expect(vistos.has('640,640')).toBe(true);
    expect(vistos.has('640,-640')).toBe(true);
  });

  it('los muros de carril separan de verdad: no se cruza por el centro', () => {
    // A la altura del bloque central, cruzar del carril central al pasillo
    // norte tiene que estar cortado por el muro.
    expect(traceRay(world, vec3(0, 320, 40), vec3(0, 600, 40)).hit).toBe(true);
  });

  it('los pasillos no son un angulo largo de punta a punta', () => {
    // Un pilar parte cada pasillo: sin el, el mapa seria dos rectas de 2300
    // unidades y el rifle de precision no tendria rival.
    expect(traceRay(world, vec3(-1100, 608, 40), vec3(1100, 608, 40)).hit).toBe(true);
  });

  it('el hueco entre carriles no se cubre desde el propio spawn', () => {
    // La esquina ciega junto al hueco: desde el spawn no se ve lo que hay
    // detras de ella, asi que cruzar no es gratis para ninguno de los dos.
    const [spawn] = CONDUIT.spawns;
    const ojo = vec3(spawn.pos.x, spawn.pos.y, spawn.pos.z + 64);
    expect(traceRay(world, ojo, vec3(-640, 560, 40)).hit).toBe(true);
  });
});
