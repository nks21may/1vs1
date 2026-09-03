/**
 * Tests de prediccion y reconciliacion.
 *
 * La propiedad importante es que, con la misma simulacion en ambos lados, la
 * correccion sea exactamente cero: si estos tests fallan, el jugador notaria
 * tirones al moverse.
 */

import { describe, expect, it } from 'vitest';

import {
  ATRIUM_WORLD,
  BUTTON,
  MAX_HEALTH,
  SNAPSHOT_FLAG,
  TICK_DT,
  type PlayerSnapshot,
  type PlayerState,
  type UserCommand,
  createPlayer,
  simulatePlayerTick,
  vec3,
} from '@neonduel/shared';

import { PredictionSystem, RECONCILE_THRESHOLD } from '../src/game/prediction.js';

const spawn = () => {
  const player = createPlayer(1, 'YO', vec3(-700, -300, 8));
  player.onGround = true;
  return player;
};

const cmd = (seq: number, buttons = 0, yaw = 0): UserCommand => ({
  seq,
  buttons,
  yaw,
  pitch: 0,
  dt: TICK_DT,
});

/** Instantanea del servidor construida a partir de un estado simulado. */
const snapshotOf = (player: PlayerState): PlayerSnapshot => ({
  id: player.id,
  name: player.name,
  x: player.pos.x,
  y: player.pos.y,
  z: player.pos.z,
  vx: player.vel.x,
  vy: player.vel.y,
  vz: player.vel.z,
  yaw: player.yaw,
  pitch: player.pitch,
  flags:
    (player.ducking ? SNAPSHOT_FLAG.DUCKING : 0) |
    (player.onGround ? SNAPSHOT_FLAG.ON_GROUND : 0) |
    (player.alive ? SNAPSHOT_FLAG.ALIVE : 0),
  health: player.health,
  weapon: player.weapon,
  ammo: player.ammo[player.weapon],
  reload: 0,
  score: 0,
});

describe('prediccion', () => {
  it('mueve al jugador de inmediato, sin esperar al servidor', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const startX = prediction.player.pos.x;

    for (let i = 1; i <= 16; i++) prediction.apply(cmd(i, BUTTON.FORWARD));

    expect(prediction.player.pos.x).toBeGreaterThan(startX);
    expect(prediction.pendingCount).toBe(16);
  });

  it('guarda los comandos hasta que el servidor los confirma', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const server = spawn();

    for (let i = 1; i <= 10; i++) {
      const command = cmd(i, BUTTON.FORWARD);
      prediction.apply(command);
      simulatePlayerTick(server, command, ATRIUM_WORLD);
    }

    prediction.reconcile(snapshotOf(server), 10);
    expect(prediction.pendingCount).toBe(0);
  });
});

describe('reconciliacion', () => {
  it('no corrige nada cuando cliente y servidor coinciden', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const server = spawn();

    let result = { corrected: true, error: 0, replayed: 0 };
    for (let i = 1; i <= 40; i++) {
      const command = cmd(i, BUTTON.FORWARD | (i % 8 === 0 ? BUTTON.JUMP : 0), i * 2);
      prediction.apply(command);
      simulatePlayerTick(server, command, ATRIUM_WORLD);
      result = prediction.reconcile(snapshotOf(server), i);
    }

    expect(result.corrected).toBe(false);
    expect(result.error).toBeLessThan(RECONCILE_THRESHOLD);
  });

  it('deja intactos los comandos que el servidor aun no ha visto', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const server = spawn();

    // El servidor va cinco comandos por detras, como con latencia real.
    for (let i = 1; i <= 5; i++) {
      const command = cmd(i, BUTTON.FORWARD);
      prediction.apply(command);
      simulatePlayerTick(server, command, ATRIUM_WORLD);
    }
    for (let i = 6; i <= 10; i++) prediction.apply(cmd(i, BUTTON.FORWARD));

    const result = prediction.reconcile(snapshotOf(server), 5);
    expect(result.corrected).toBe(false);
    expect(prediction.pendingCount).toBe(5);
  });

  it('corrige y repite los comandos pendientes si el servidor discrepa', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const server = spawn();

    for (let i = 1; i <= 10; i++) {
      const command = cmd(i, BUTTON.FORWARD);
      prediction.apply(command);
      simulatePlayerTick(server, command, ATRIUM_WORLD);
    }
    for (let i = 11; i <= 16; i++) prediction.apply(cmd(i, BUTTON.FORWARD));

    // El servidor dice que el jugador estaba 60 unidades mas atras (por ejemplo,
    // porque el cliente predijo mal un choque).
    const corrupted = snapshotOf(server);
    corrupted.y += 60;

    const result = prediction.reconcile(corrupted, 10);
    expect(result.corrected).toBe(true);
    expect(result.error).toBeGreaterThan(RECONCILE_THRESHOLD);
    expect(result.replayed).toBe(6);
    // Tras corregir, la posicion parte de la del servidor mas los seis comandos.
    expect(prediction.player.pos.y).toBeGreaterThan(corrupted.y - 5);
  });

  it('acepta el estado del servidor si no reconoce el comando confirmado', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const far = snapshotOf(spawn());
    far.x = 500;
    far.y = 250;

    const result = prediction.reconcile(far, 9999);
    expect(result.corrected).toBe(true);
    expect(prediction.player.pos.x).toBe(500);
    expect(prediction.pendingCount).toBe(0);
  });

  it('la vida siempre viene del servidor, nunca se predice', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const server = spawn();

    const command = cmd(1, BUTTON.FORWARD);
    prediction.apply(command);
    simulatePlayerTick(server, command, ATRIUM_WORLD);

    const snapshot = snapshotOf(server);
    snapshot.health = 37;
    prediction.reconcile(snapshot, 1);

    expect(prediction.player.health).toBe(37);
  });

  it('la muerte informada por el servidor se aplica al instante', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const server = spawn();
    const command = cmd(1);
    prediction.apply(command);
    simulatePlayerTick(server, command, ATRIUM_WORLD);

    const snapshot = snapshotOf(server);
    snapshot.health = 0;
    snapshot.flags &= ~SNAPSHOT_FLAG.ALIVE;
    prediction.reconcile(snapshot, 1);

    expect(prediction.player.alive).toBe(false);
  });

  it('reset deja el estado limpio para la ronda siguiente', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    for (let i = 1; i <= 10; i++) prediction.apply(cmd(i, BUTTON.FORWARD));

    const fresh = snapshotOf(spawn());
    fresh.x = 1056;
    prediction.reset(fresh);

    expect(prediction.pendingCount).toBe(0);
    expect(prediction.player.pos.x).toBe(1056);
    expect(prediction.player.vel).toEqual(vec3());
    expect(prediction.player.health).toBe(MAX_HEALTH);
  });
});

describe('prediccion con perdida de paquetes', () => {
  it('converge aunque se pierdan instantaneas por el camino', () => {
    const prediction = new PredictionSystem(spawn(), ATRIUM_WORLD);
    const server = spawn();
    let lastAck = 0;

    for (let i = 1; i <= 120; i++) {
      const command = cmd(i, BUTTON.FORWARD | (i % 16 === 0 ? BUTTON.JUMP : 0), i);
      prediction.apply(command);
      simulatePlayerTick(server, command, ATRIUM_WORLD);
      lastAck = i;

      // Solo una de cada cinco instantaneas llega.
      if (i % 5 === 0) prediction.reconcile(snapshotOf(server), lastAck);
    }

    const finalError = Math.hypot(
      prediction.player.pos.x - server.pos.x,
      prediction.player.pos.y - server.pos.y,
      prediction.player.pos.z - server.pos.z,
    );
    expect(finalError).toBeLessThan(RECONCILE_THRESHOLD);
  });
});
