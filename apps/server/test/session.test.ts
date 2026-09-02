/**
 * Tests de la sesion autoritativa.
 *
 * `MatchSession.update()` no consulta ningun reloj, asi que aqui se simulan
 * rondas enteras en milisegundos y sin sockets.
 */

import { describe, expect, it } from 'vitest';

import {
  BUTTON,
  DEFAULT_MATCH_CONFIG,
  MAX_COMMANDS_PER_TICK,
  MAX_HEALTH,
  PLAYER_HEIGHT_STANDING,
  SNAPSHOT_FLAG,
  TICK_DT,
  type UserCommand,
  vec3,
} from '@neonduel/shared';

import { MemoryConnection } from '../src/connection.js';
import { MatchSession } from '../src/session.js';

const config = { ...DEFAULT_MATCH_CONFIG, roundsToWin: 2 };

const newSession = () => {
  const session = new MatchSession({ matchConfig: config, matchId: 'test' });
  const a = new MemoryConnection(1, 'ALFA');
  const b = new MemoryConnection(2, 'BETA');
  session.join(a);
  session.join(b);
  return { session, a, b };
};

const ticks = (session: MatchSession, count: number) => {
  for (let i = 0; i < count; i++) session.update();
};

/** Avanza hasta que la ronda esta en juego. */
const goLive = (session: MatchSession) => {
  let guard = 0;
  while (session.match.phase !== 'live' && guard++ < 2000) session.update();
};

const cmd = (seq: number, buttons = 0, yaw = 0, pitch = 0): UserCommand => ({
  seq,
  buttons,
  yaw,
  pitch,
  dt: TICK_DT,
});

const input = (cmds: UserCommand[]) =>
  ({ t: 'input', cmds, interp: 0, rtt: 0 }) as const;

describe('conexion a la partida', () => {
  it('envia la bienvenida con el identificador asignado', () => {
    const { a } = newSession();
    const welcome = a.last('welcome');
    expect(welcome).toMatchObject({ playerId: 1, mapName: 'ATRIUM', tickRate: 64 });
  });

  it('con dos jugadores arranca el calentamiento', () => {
    const { session } = newSession();
    expect(session.match.phase).toBe('warmup');
    expect(session.playerCount).toBe(2);
    expect(session.isFull).toBe(true);
  });

  it('difunde instantaneas a todos los jugadores', () => {
    const { session, a, b } = newSession();
    ticks(session, 3);
    expect(a.all('snapshot')).toHaveLength(3);
    expect(b.all('snapshot')).toHaveLength(3);
    expect(a.last('snapshot')!.players).toHaveLength(2);
  });

  it('el nombre del join llega al snapshot', () => {
    const { session, a } = newSession();
    session.handleMessage(1, { t: 'join', name: 'NEO', version: 1 });
    ticks(session, 1);
    const me = a.last('snapshot')!.players.find((p) => p.id === 1);
    expect(me!.name).toBe('NEO');
  });

  it('responde al ping con el eco del cliente', () => {
    const { session, a } = newSession();
    ticks(session, 2);
    session.handleMessage(1, { t: 'ping', time: 987 });
    expect(a.last('pong')).toMatchObject({ time: 987 });
  });

  it('ignora los mensajes de una conexion desconocida', () => {
    const { session } = newSession();
    expect(() => session.handleMessage(99, input([cmd(1)]))).not.toThrow();
  });
});

describe('procesado de comandos', () => {
  it('confirma la ultima secuencia procesada', () => {
    const { session, a } = newSession();
    session.handleMessage(1, input([cmd(1), cmd(2), cmd(3)]));
    ticks(session, 1);
    expect(a.last('snapshot')!.ack).toBe(3);
  });

  it('descarta los comandos reenviados por redundancia', () => {
    const { session } = newSession();
    goLive(session);
    const player = session.playerOf(1)!;
    const startX = player.pos.x;

    session.handleMessage(1, input([cmd(1, BUTTON.FORWARD)]));
    // El mismo comando vuelve a llegar en el siguiente paquete.
    session.handleMessage(1, input([cmd(1, BUTTON.FORWARD), cmd(2, BUTTON.FORWARD)]));
    ticks(session, 1);

    const twoCommandsDistance = Math.abs(player.pos.x - startX);
    expect(twoCommandsDistance).toBeGreaterThan(0);
    expect(player.shotCounter).toBe(0);

    // Reenviar solo lo ya visto no debe mover al jugador otra vez.
    const beforeReplay = player.pos.x;
    session.handleMessage(1, input([cmd(1, BUTTON.FORWARD), cmd(2, BUTTON.FORWARD)]));
    ticks(session, 1);
    expect(Math.abs(player.pos.x - beforeReplay)).toBeLessThan(twoCommandsDistance);
  });

  it('limita cuantos comandos se procesan por tick', () => {
    const { session, a } = newSession();
    goLive(session);
    const many = Array.from({ length: 40 }, (_, i) => cmd(i + 1, BUTTON.FORWARD));
    for (const c of many) session.handleMessage(1, input([c]));

    ticks(session, 1);
    expect(a.last('snapshot')!.ack).toBeLessThanOrEqual(MAX_COMMANDS_PER_TICK);
  });

  it('sigue simulando la gravedad aunque el cliente deje de enviar', () => {
    const { session } = newSession();
    goLive(session);
    const player = session.playerOf(1)!;
    player.pos = vec3(player.pos.x, player.pos.y, player.pos.z + 200);
    player.onGround = false;

    const startZ = player.pos.z;
    ticks(session, 20);
    expect(player.pos.z).toBeLessThan(startZ);
  });
});

describe('fases de ronda', () => {
  it('durante el calentamiento no se puede mover ni disparar', () => {
    const { session } = newSession();
    expect(session.match.isFrozen).toBe(true);
    const player = session.playerOf(1)!;
    const startPos = { ...player.pos };

    session.handleMessage(1, input([cmd(1, BUTTON.FORWARD | BUTTON.ATTACK)]));
    ticks(session, 1);

    expect(player.pos.x).toBeCloseTo(startPos.x, 6);
    expect(player.ammo.rifle).toBe(30);
  });

  it('en juego si se puede mover', () => {
    const { session } = newSession();
    goLive(session);
    const player = session.playerOf(1)!;
    const startX = player.pos.x;

    for (let i = 0; i < 32; i++) {
      session.handleMessage(1, input([cmd(i + 1, BUTTON.FORWARD, 0)]));
      session.update();
    }
    expect(Math.abs(player.pos.x - startX)).toBeGreaterThan(50);
  });

  it('cada ronda intercambia los lados del mapa', () => {
    const { session } = newSession();
    goLive(session);
    const firstX = session.playerOf(1)!.pos.x;

    session.playerOf(2)!.health = 1;
    session.playerOf(2)!.alive = false;
    session.match.reportDeath(2);
    // Avanzar hasta la siguiente ronda en juego.
    goLive(session);

    expect(Math.sign(session.playerOf(1)!.pos.x)).toBe(-Math.sign(firstX));
  });
});

describe('disparos', () => {
  /**
   * Coloca a los dos jugadores enfrentados a `distance` unidades en el carril
   * sur del mapa, que esta despejado (el centro lo ocupa el monolito).
   */
  const faceOff = (session: MatchSession, distance = 400) => {
    const shooter = session.playerOf(1)!;
    const target = session.playerOf(2)!;
    shooter.pos = vec3(-700, -300, 0);
    shooter.vel = vec3();
    shooter.onGround = true;
    target.pos = vec3(-700 + distance, -300, 0);
    target.vel = vec3();
    target.onGround = true;
    return { shooter, target };
  };

  it('acierta al rival y le resta vida', () => {
    const { session, a } = newSession();
    goLive(session);
    const { target } = faceOff(session);

    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK, 0, 0)]));
    session.update();

    expect(target.health).toBeLessThan(MAX_HEALTH);
    const hit = a.last('snapshot')!.events.find((e) => e.t === 'hit');
    expect(hit).toMatchObject({ attacker: 1, victim: 2 });
  });

  it('un disparo a la cabeza mata de una vez', () => {
    const { session, a } = newSession();
    goLive(session);
    const { shooter, target } = faceOff(session, 300);
    // Apuntar a la cabeza: el objetivo esta a la misma altura, asi que basta
    // con inclinar la vista hacia arriba la diferencia entre ojos y coronilla.
    const dz = PLAYER_HEIGHT_STANDING - 6 - 64;
    const pitch = -(Math.atan2(dz, 300) * 180) / Math.PI;
    void target;
    shooter.pitch = pitch;

    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK, 0, pitch)]));
    session.update();

    expect(target.alive).toBe(false);
    const death = a.last('snapshot')!.events.find((e) => e.t === 'death');
    expect(death).toMatchObject({ victim: 2, killer: 1, group: 'head' });
  });

  it('una pared bloquea la bala', () => {
    const { session } = newSession();
    goLive(session);
    const { shooter, target } = faceOff(session);
    // El monolito central bloquea la linea entre los dos carriles.
    shooter.pos = vec3(-600, 0, 0);
    target.pos = vec3(600, 0, 0);
    shooter.pitch = 0;

    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK, 0, 0)]));
    session.update();

    expect(target.health).toBe(MAX_HEALTH);
  });

  it('el disparo genera un evento con origen y destino', () => {
    const { session, b } = newSession();
    goLive(session);
    faceOff(session);

    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK)]));
    session.update();

    const shot = b.last('snapshot')!.events.find((e) => e.t === 'shot');
    expect(shot).toBeDefined();
    // El rival no lo marca como local: debe dibujar el trazador.
    expect(shot && 'local' in shot ? shot.local : undefined).toBeUndefined();
  });

  it('marca como local el disparo del propio jugador', () => {
    const { session, a } = newSession();
    goLive(session);
    faceOff(session);

    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK)]));
    session.update();

    const shot = a.last('snapshot')!.events.find((e) => e.t === 'shot');
    expect(shot).toMatchObject({ local: true });
  });

  it('matar termina la ronda y suma un punto', () => {
    const { session } = newSession();
    goLive(session);
    const { target } = faceOff(session, 200);
    target.health = 1;

    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK)]));
    session.update();

    expect(target.alive).toBe(false);
    expect(session.match.scoreOf(1)).toBe(1);
    expect(session.match.phase).toBe('roundEnd');
  });

  it('la ronda siguiente devuelve la vida completa', () => {
    const { session } = newSession();
    goLive(session);
    const { target } = faceOff(session, 200);
    target.health = 1;

    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK)]));
    session.update();
    goLive(session);

    expect(session.playerOf(2)!.health).toBe(MAX_HEALTH);
    expect(session.playerOf(2)!.alive).toBe(true);
    expect(session.playerOf(2)!.ammo.rifle).toBe(30);
  });
});

describe('compensacion de latencia', () => {
  it('acierta a donde el cliente veia al rival, no a donde esta ahora', () => {
    const { session } = newSession();
    goLive(session);

    const shooter = session.playerOf(1)!;
    const target = session.playerOf(2)!;
    shooter.pos = vec3(-700, -300, 0);
    shooter.onGround = true;
    target.pos = vec3(-300, -300, 0);
    target.onGround = true;

    // Se acumula historial con el objetivo quieto.
    ticks(session, 20);

    // El objetivo se aparta de golpe fuera de la linea de tiro.
    target.pos = vec3(-300, -100, 0);
    ticks(session, 3);

    // Un cliente con 150 ms de ida y vuelta dispara a la posicion que veia.
    session.handleMessage(1, {
      t: 'input',
      cmds: [cmd(1, BUTTON.ATTACK, 0, 0)],
      interp: 100,
      rtt: 150,
    });
    session.update();

    expect(target.health).toBeLessThan(MAX_HEALTH);
  });

  it('sin latencia declarada se dispara al presente', () => {
    const { session } = newSession();
    goLive(session);

    const shooter = session.playerOf(1)!;
    const target = session.playerOf(2)!;
    shooter.pos = vec3(-700, -300, 0);
    shooter.onGround = true;
    target.pos = vec3(-300, -300, 0);
    target.onGround = true;
    ticks(session, 20);

    target.pos = vec3(-300, -100, 0);
    ticks(session, 3);

    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK, 0, 0)]));
    session.update();

    expect(target.health).toBe(MAX_HEALTH);
  });
});

describe('desconexion', () => {
  it('abandonar da la partida al rival', () => {
    const { session } = newSession();
    goLive(session);
    session.leave(2);

    expect(session.playerCount).toBe(1);
    expect(session.match.matchWinner).toBe(1);
  });

  it('salir dos veces no rompe nada', () => {
    const { session } = newSession();
    session.leave(2);
    expect(() => session.leave(2)).not.toThrow();
  });
});

describe('contenido del snapshot', () => {
  it('incluye postura, vida y marcador', () => {
    const { session, a } = newSession();
    goLive(session);
    ticks(session, 1);

    const me = a.last('snapshot')!.players.find((p) => p.id === 1)!;
    expect(me.health).toBe(MAX_HEALTH);
    expect(me.flags & SNAPSHOT_FLAG.ALIVE).toBeTruthy();
    expect(me.score).toBe(0);
    expect(me.ammo).toBe(30);
  });

  it('redondea las posiciones para ahorrar ancho de banda', () => {
    const { session, a } = newSession();
    goLive(session);
    session.playerOf(1)!.pos = vec3(1.23456, 2.34567, 3.45678);
    ticks(session, 1);

    const me = a.last('snapshot')!.players.find((p) => p.id === 1)!;
    expect(me.x).toBe(1.23);
    expect(me.y).toBe(2.35);
  });

  it('informa del progreso de recarga', () => {
    const { session, a } = newSession();
    goLive(session);
    session.playerOf(1)!.ammo.rifle = 3;
    session.handleMessage(1, input([cmd(1, BUTTON.RELOAD)]));
    ticks(session, 10);

    const me = a.last('snapshot')!.players.find((p) => p.id === 1)!;
    expect(me.reload).toBeGreaterThan(0);
    expect(me.reload).toBeLessThan(1);
  });
});
