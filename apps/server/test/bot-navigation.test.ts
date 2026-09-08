/**
 * El criterio de T09: el bot llega a cualquier punto desde cualquier otro.
 *
 * No se comprueba sobre el grafo (eso ya lo hace `navigation.test.ts`), sino
 * caminando de verdad: se simula al bot con la fisica real siguiendo sus
 * propios comandos. Un grafo conectado no garantiza que quien lo recorre no se
 * quede enganchado en una esquina.
 */

import { describe, expect, it } from 'vitest';

import {
  MAPS,
  TICK_DT,
  type GameMap,
  type Vec3,
  createCollisionWorld,
  createPlayer,
  navGraphOf,
  simulatePlayerTick,
} from '@neonduel/shared';

import { BOT_DIFFICULTIES, BotController } from '../src/bot.js';

/** 25 segundos: la diagonal de los mapas se cruza en menos de doce. */
const LIMITE_TICKS = Math.round(25 / TICK_DT);
const RADIO_LLEGADA = 64;

/** Camina como el bot hasta `destino` y dice en cuantos ticks llego. */
const caminar = (map: GameMap, desde: Vec3, destino: Vec3): number | null => {
  const world = createCollisionWorld(map);
  const bot = new BotController(1, map, BOT_DIFFICULTIES.hard, 0x51e);
  const player = createPlayer(1, 'BOT', desde, 0);

  for (let tick = 0; tick < LIMITE_TICKS; tick++) {
    const buttons = bot.navigateTo(player, destino);
    // El yaw se mantiene fijo: el bot apunta a otro lado mientras anda, asi que
    // moverse tiene que funcionar sin girarse hacia donde va.
    simulatePlayerTick(player, { seq: tick, buttons, yaw: 0, pitch: 0, dt: TICK_DT }, world);

    const d = Math.hypot(player.pos.x - destino.x, player.pos.y - destino.y);
    if (d < RADIO_LLEGADA && Math.abs(player.pos.z - destino.z) < 80) return tick;
  }
  return null;
};

describe('caminos degenerados', () => {
  const atrium = MAPS.ATRIUM!;

  it('estar ya en el destino no se lleva por delante el servidor', () => {
    const nodo = navGraphOf(atrium).nodes[0]!;
    const bot = new BotController(1, atrium, BOT_DIFFICULTIES.hard, 0x51e);
    const player = createPlayer(1, 'BOT', { ...nodo }, 0);

    // Si el bot y su objetivo caen en el mismo nodo del grafo, el camino es ese
    // unico nodo y el bot ya esta encima. Con la version recursiva eso hacia que
    // `navigateTo` se llamase a si misma sin fin: un `Maximum call stack size
    // exceeded` que mataba el proceso entero, no solo esa partida. Y no era un
    // caso rebuscado: basta con perseguir a alguien que esta al lado.
    for (let tick = 0; tick < 300; tick++) {
      expect(() => bot.navigateTo(player, { ...nodo })).not.toThrow();
    }
  });

  it('un destino fuera del mapa tampoco', () => {
    const bot = new BotController(1, atrium, BOT_DIFFICULTIES.hard, 0x51e);
    const player = createPlayer(1, 'BOT', { ...atrium.spawns[0].pos }, 0);

    for (let tick = 0; tick < 300; tick++) {
      expect(() => bot.navigateTo(player, { x: 1e6, y: 1e6, z: 1e6 })).not.toThrow();
    }
  });
});

describe.each(Object.entries(MAPS))('el bot recorre %s', (_nombre, mapa) => {
  const nodos = navGraphOf(mapa).nodes;

  /** Puntos extremos del mapa: las esquinas son lo que mas cuesta alcanzar. */
  const extremos = (): Vec3[] => {
    const por = (f: (n: Vec3) => number) =>
      nodos.reduce((mejor, n) => (f(n) > f(mejor) ? n : mejor), nodos[0]!);
    return [por((n) => n.x), por((n) => -n.x), por((n) => n.y), por((n) => -n.y), por((n) => n.z)];
  };

  it('va de un spawn al otro', () => {
    const [a, b] = mapa.spawns;
    expect(caminar(mapa, a.pos, b.pos)).not.toBeNull();
  });

  it('llega a los extremos del mapa desde el spawn', () => {
    const [spawn] = mapa.spawns;
    for (const destino of extremos()) {
      expect(caminar(mapa, spawn.pos, destino)).not.toBeNull();
    }
  });

  it('y vuelve desde ellos al spawn', () => {
    const destino = mapa.spawns[1].pos;
    for (const desde of extremos()) {
      expect(caminar(mapa, desde, destino)).not.toBeNull();
    }
  });
});
