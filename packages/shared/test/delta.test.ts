/**
 * Instantaneas diferenciales.
 *
 * La propiedad que importa es una sola: aplicar la secuencia de diferencias
 * tiene que dar exactamente el mismo estado que habrian dado las completas. Si
 * eso falla, el cliente dibuja un mundo que no existe y nadie se entera.
 */

import { describe, expect, it } from 'vitest';

import { SnapshotDecoder, applyPlayersDiff, diffPlayers } from '../src/delta.js';
import type { PlayerSnapshot, SnapshotMessage } from '../src/protocol.js';

const player = (id: number, over: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
  id,
  name: `P${id}`,
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  pitch: 0,
  flags: 6,
  duck: 0,
  health: 100,
  weapon: 'rifle',
  ammo: 30,
  reload: 0,
  score: 0,
  stats: { kills: 0, deaths: 0, shots: 0, hits: 0 },
  ...over,
});

/** Generador reproducible: los tests no pueden depender del azar del dia. */
const lcg = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const snapshot = (tick: number, players: PlayerSnapshot[]): SnapshotMessage => ({
  t: 'snapshot',
  tick,
  time: tick * 15.625,
  ack: tick,
  players,
  phase: 'live',
  phaseTime: 60,
  round: 1,
  events: [],
});

describe('diferencias de jugadores', () => {
  it('sin cambios no viaja nada', () => {
    const antes = [player(1), player(2)];
    const diff = diffPlayers(antes, [player(1), player(2)]);

    expect(diff.players).toEqual([]);
    expect(diff.gone).toEqual([]);
  });

  it('solo viaja el campo que ha cambiado, con el id para saber de quien es', () => {
    const antes = [player(1)];
    const diff = diffPlayers(antes, [player(1, { x: 42 })]);

    expect(diff.players).toEqual([{ id: 1, x: 42 }]);
  });

  it('las estadisticas no se repiten en cada tick, solo cuando cambian', () => {
    const antes = [player(1, { stats: { kills: 1, deaths: 0, shots: 9, hits: 3 } })];
    const quieto = diffPlayers(antes, [
      player(1, { x: 5, stats: { kills: 1, deaths: 0, shots: 9, hits: 3 } }),
    ]);
    expect(Object.keys(quieto.players[0]!).sort()).toEqual(['id', 'x']);

    const disparando = diffPlayers(antes, [
      player(1, { stats: { kills: 1, deaths: 0, shots: 10, hits: 3 } }),
    ]);
    expect(disparando.players[0]).toMatchObject({ stats: { shots: 10 } });
  });

  it('un jugador nuevo viaja entero, porque no hay nada sobre lo que aplicarlo', () => {
    const diff = diffPlayers([player(1)], [player(1), player(2, { x: 7 })]);

    expect(diff.players).toHaveLength(1);
    expect(diff.players[0]).toEqual(player(2, { x: 7 }));
  });

  it('un jugador que se va se anuncia aparte', () => {
    const diff = diffPlayers([player(1), player(2)], [player(1)]);

    expect(diff.gone).toEqual([2]);
    expect(applyPlayersDiff([player(1), player(2)], diff).map((p) => p.id)).toEqual([1]);
  });

  it('una secuencia de diferencias da el mismo estado que las completas', () => {
    const random = lcg(20260905);
    let completas = [player(1), player(2, { x: 400 })];
    let reconstruido = completas.map((p) => ({ ...p }));

    for (let tick = 0; tick < 500; tick++) {
      const siguientes = completas.map((p) => ({
        ...p,
        // Lo que cambia cada tick: posicion, velocidad y angulos.
        x: Math.round((p.x + random() * 20 - 10) * 100) / 100,
        y: Math.round((p.y + random() * 20 - 10) * 100) / 100,
        z: Math.round((p.z + random() * 4 - 2) * 100) / 100,
        vx: Math.round(random() * 500),
        yaw: Math.round(random() * 360),
        pitch: Math.round(random() * 180 - 90),
        // Y lo que cambia de higos a brevas.
        ...(random() < 0.02 ? { health: Math.max(0, p.health - 26) } : {}),
        ...(random() < 0.01 ? { weapon: 'pistol' as const, ammo: 20 } : {}),
        ...(random() < 0.01 ? { stats: { ...p.stats, shots: p.stats.shots + 1 } } : {}),
        ...(random() < 0.005 ? { score: p.score + 1 } : {}),
      }));

      reconstruido = applyPlayersDiff(reconstruido, diffPlayers(completas, siguientes));
      completas = siguientes;

      expect(reconstruido).toEqual(completas);
    }
  });
});

describe('SnapshotDecoder', () => {
  it('una instantanea completa se aplica sin nada previo', () => {
    const decoder = new SnapshotDecoder();
    const full = decoder.decode(snapshot(10, [player(1), player(2)]));

    expect(full?.players).toHaveLength(2);
    expect(full?.tick).toBe(10);
  });

  it('reconstruye la completa a partir de la diferencia', () => {
    const decoder = new SnapshotDecoder();
    decoder.decode(snapshot(10, [player(1), player(2)]));

    const full = decoder.decode({
      ...snapshot(11, [{ id: 1, x: 99 }]),
      base: 10,
    });

    expect(full?.players).toHaveLength(2);
    expect(full?.players.find((p) => p.id === 1)?.x).toBe(99);
    // El resto del jugador se conserva: no se ha perdido nada por el camino.
    expect(full?.players.find((p) => p.id === 1)?.health).toBe(100);
  });

  it('descarta la diferencia que no encaja y se recupera con la siguiente completa', () => {
    const decoder = new SnapshotDecoder();
    decoder.decode(snapshot(10, [player(1)]));

    // Una diferencia contra un tick que este cliente nunca vio.
    expect(decoder.decode({ ...snapshot(12, [{ id: 1, x: 5 }]), base: 11 })).toBeNull();
    // Y la siguiente tampoco, porque su base es la que se acaba de descartar.
    expect(decoder.decode({ ...snapshot(13, [{ id: 1, x: 6 }]), base: 12 })).toBeNull();

    // La completa que el servidor manda cada segundo cura el desajuste.
    const full = decoder.decode(snapshot(14, [player(1, { x: 7 })]));
    expect(full?.players[0]?.x).toBe(7);
  });

  it('no arrastra estado de una conexion a la siguiente', () => {
    const decoder = new SnapshotDecoder();
    decoder.decode(snapshot(10, [player(1)]));
    decoder.reset();

    expect(decoder.decode({ ...snapshot(11, [{ id: 1, x: 5 }]), base: 10 })).toBeNull();
  });
});
