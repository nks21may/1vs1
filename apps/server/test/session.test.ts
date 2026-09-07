/**
 * Tests de la sesion autoritativa.
 *
 * `MatchSession.update()` no consulta ningun reloj, asi que aqui se simulan
 * rondas enteras en milisegundos y sin sockets.
 */

import { describe, expect, it } from 'vitest';

import {
  ATRIUM,
  BUTTON,
  DEFAULT_MATCH_CONFIG,
  INTERP_DELAY_MS,
  MAX_COMMANDS_PER_TICK,
  MAX_HEALTH,
  PLAYER_HEIGHT_STANDING,
  SNAPSHOT_FLAG,
  TICK_DT,
  TICK_INTERVAL_MS,
  type UserCommand,
  accuracy,
  createCollisionWorld,
  createMoveState,
  moveStep,
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

/**
 * Ticks que hay que dejar correr despues de colocar a los jugadores a mano.
 * El servidor rebobina el retardo de interpolacion en todos los disparos, asi
 * que colocarlos y disparar en el mismo instante resolveria la bala contra un
 * historial que todavia los tiene en el punto de aparicion.
 */
const SETTLE_TICKS = Math.ceil(INTERP_DELAY_MS / TICK_INTERVAL_MS) + 1;

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

/**
 * `ackTick` es la instantanea que el cliente dice estar viendo, y es lo unico
 * con lo que el servidor mide su latencia. Por defecto va a cero: un cliente
 * que aun no ha aplicado ninguna, o sea sin latencia medida.
 */
const input = (cmds: UserCommand[], ackTick = 0) => ({ t: 'input', cmds, ackTick }) as const;

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

  /**
   * El bug que fija este test: al quedarse sin comandos el servidor repetia el
   * ultimo con `buttons: 0`, asi que levantaba a un jugador que seguia agachado
   * en su pantalla. Como los huecos son constantes con el jitter normal de la
   * red, la velocidad maxima simulada saltaba de 73 a 215 u/s varias veces por
   * segundo y la correccion resultante sacudia la camara.
   */
  it('sin comandos nuevos conserva la postura en vez de levantar al jugador', () => {
    const { session } = newSession();
    goLive(session);

    session.handleMessage(1, input([cmd(1, BUTTON.DUCK)]));
    ticks(session, 30);

    const player = session.playerOf(1)!;
    expect(player.ducking).toBe(true);
    expect(player.duckProgress).toBe(1);
  });

  it('sin comandos nuevos no dispara ni avanza en nombre del cliente', () => {
    const { session, a } = newSession();
    goLive(session);

    session.handleMessage(1, input([cmd(1, BUTTON.FORWARD | BUTTON.ATTACK)]));
    const player = session.playerOf(1)!;
    ticks(session, 1);
    const after = { x: player.pos.x, y: player.pos.y, ammo: player.ammo.rifle };

    ticks(session, 30);
    expect(player.ammo.rifle).toBe(after.ammo);
    // Se frena por friccion; lo que no puede es seguir acelerando solo.
    expect(Math.hypot(player.pos.x - after.x, player.pos.y - after.y)).toBeLessThan(60);
    expect(a.last('snapshot')).toBeDefined();
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
    ticks(session, SETTLE_TICKS);
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

/**
 * La latencia no se declara: el cliente va reconociendo instantaneas y el
 * servidor mide cuanto tardan en volver. Un tick son 15,625 ms, asi que
 * reconocer 7 ticks por detras equivale a 109 ms de ida y vuelta.
 */
const latencyScenario = (lagTicks: number, packets = 20) => {
  const { session } = newSession();
  goLive(session);

  const shooter = session.playerOf(1)!;
  const target = session.playerOf(2)!;
  shooter.pos = vec3(-700, -300, 0);
  shooter.onGround = true;
  target.pos = vec3(-300, -300, 0);
  target.onGround = true;

  let seq = 0;
  const ackFor = (lag: number) => Math.max(1, session.tick - lag);
  const report = (lag: number, count = 1) => {
    for (let i = 0; i < count; i++) {
      session.handleMessage(1, input([cmd(++seq)], ackFor(lag)));
      session.update();
    }
  };
  const shoot = (lag: number) => {
    session.handleMessage(1, input([cmd(++seq, BUTTON.ATTACK, 0, 0)], ackFor(lag)));
    session.update();
  };

  // Ventana entera de medidas antes de que pase nada interesante.
  report(lagTicks, packets);
  return { session, shooter, target, shoot };
};

/** Saca al objetivo de la linea de tiro y deja pasar `after` ticks. */
const dodge = (scenario: ReturnType<typeof latencyScenario>, after: number) => {
  scenario.target.pos = vec3(-300, -100, 0);
  ticks(scenario.session, after);
};

describe('compensacion de latencia', () => {
  it('acierta a donde el cliente veia al rival, no a donde esta ahora', () => {
    const escena = latencyScenario(7);
    dodge(escena, 3);

    // 55 ms de ida mas 100 de interpolacion: casi diez ticks atras, cuando el
    // objetivo todavia estaba en la linea de tiro.
    escena.shoot(7);

    expect(escena.target.health).toBeLessThan(MAX_HEALTH);
  });

  it('sin latencia medida se rebobina solo el retardo de interpolacion', () => {
    // Nadie dibuja el presente: todo cliente va 100 ms por detras, asi que ese
    // rebobinado existe aunque la latencia medida sea cero. Son 6,4 ticks.
    const cerca = latencyScenario(0);
    dodge(cerca, 3);
    cerca.shoot(0);
    expect(cerca.target.health).toBeLessThan(MAX_HEALTH);

    const lejos = latencyScenario(0);
    dodge(lejos, 10);
    lejos.shoot(0);
    expect(lejos.target.health).toBe(MAX_HEALTH);
  });

  it('inflar la latencia justo al disparar no consigue mas rebobinado', () => {
    const escena = latencyScenario(0);
    dodge(escena, 10);

    // El paquete del disparo dice ir 12 ticks por detras. De creerselo serian
    // 194 ms de rebobinado, de sobra para alcanzar al objetivo donde estaba;
    // pero la estimacion es el minimo de la ventana, y la ventana esta limpia.
    escena.shoot(12);

    expect(escena.target.health).toBe(MAX_HEALTH);
  });

  it('decir que se ha visto una instantanea del futuro no compensa nada', () => {
    const escena = latencyScenario(0);
    dodge(escena, 10);

    // Un tick que el servidor aun no ha enviado da una medida negativa, que
    // vale cero: la mentira no puede hacer que le compensen de mas.
    escena.shoot(-1000);

    expect(escena.target.health).toBe(MAX_HEALTH);
  });

  it('ni sosteniendo la mentira se rebobina mas alla del tope', () => {
    // Aqui el cliente miente en todos los paquetes, que es lo unico que mueve
    // el minimo. Ningun servidor puede distinguir eso de ir retrasado de
    // verdad, y por eso existe el tope: 200 ms, o sea 12,8 ticks.
    const escena = latencyScenario(40);
    dodge(escena, 20);
    escena.shoot(40);

    expect(escena.target.health).toBe(MAX_HEALTH);
  });
});

describe('caida del socket', () => {
  it('el jugador sigue en el mundo y se le puede disparar', () => {
    const { session } = newSession();
    goLive(session);
    const shooter = session.playerOf(1)!;
    const target = session.playerOf(2)!;
    shooter.pos = vec3(-700, -300, 0);
    shooter.onGround = true;
    target.pos = vec3(-300, -300, 0);
    target.onGround = true;
    ticks(session, SETTLE_TICKS);

    // Caerse no es irse: el cuerpo se queda plantado donde estaba, que es la
    // consecuencia honesta de perder la conexion en mitad de una ronda.
    expect(session.disconnect(2)).toBe(true);
    session.handleMessage(1, input([cmd(1, BUTTON.ATTACK, 0, 0)]));
    session.update();

    expect(target.health).toBeLessThan(MAX_HEALTH);
    expect(session.playerCount).toBe(2);
  });

  it('al caido no se le mandan instantaneas', () => {
    const { session, a, b } = newSession();
    session.disconnect(1);
    const antesA = a.all('snapshot').length;
    const antesB = b.all('snapshot').length;

    ticks(session, 3);

    expect(a.all('snapshot')).toHaveLength(antesA);
    expect(b.all('snapshot')).toHaveLength(antesB + 3);
  });

  it('al volver adopta el angulo que tiene su jugador, no el que recordaba', () => {
    const { session } = newSession();
    goLive(session);
    session.playerOf(1)!.yaw = 137;
    session.disconnect(1);

    const vuelta = new MemoryConnection(1, 'ALFA');
    expect(session.reconnect(1, vuelta)).toBe(true);
    ticks(session, 1);

    expect(vuelta.last('welcome')).toMatchObject({ playerId: 1 });
    expect(vuelta.last('snapshot')!.viewYaw).toBe(137);
  });

  it('los comandos en vuelo antes de la caida no se aplican al volver', () => {
    const { session } = newSession();
    goLive(session);
    const player = session.playerOf(1)!;
    player.pos = vec3(-700, -300, 0);
    player.vel = vec3();
    player.onGround = true;

    // Ordenes de correr que se quedaron en la cola justo antes de caerse.
    session.handleMessage(1, input([cmd(1, BUTTON.FORWARD), cmd(2, BUTTON.FORWARD)]));
    session.disconnect(1);
    session.reconnect(1, new MemoryConnection(1, 'ALFA'));
    ticks(session, 2);

    expect(player.pos.x).toBeCloseTo(-700, 3);
    expect(player.pos.y).toBeCloseTo(-300, 3);
  });

  it('reconectar a alguien que no esta en la partida no hace nada', () => {
    const { session } = newSession();
    expect(session.disconnect(99)).toBe(false);
    expect(session.reconnect(99, new MemoryConnection(99))).toBe(false);
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

  it('el progreso de agachado viaja aparte del bit de postura', () => {
    const { session, a } = newSession();
    goLive(session);

    // Un solo tick agachado: la transicion dura 0,2 s, asi que el bit todavia
    // dice "de pie" mientras la camara ya ha empezado a bajar. Si el cliente
    // tuviese que deducir el progreso del bit, ahi es donde daba el tiron.
    session.handleMessage(1, input([cmd(1, BUTTON.DUCK)]));
    ticks(session, 1);

    const me = a.last('snapshot')!.players.find((p) => p.id === 1)!;
    expect(me.flags & SNAPSHOT_FLAG.DUCKING).toBeFalsy();
    expect(me.duck).toBeGreaterThan(0);
    expect(me.duck).toBeLessThan(1);
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

describe('angulo de vista al reaparecer', () => {
  /**
   * El bug que estos tests fijan: los angulos los manda el cliente en cada
   * comando, asi que girar al jugador en el servidor al cambiar de lado no
   * sirve de nada -- el siguiente comando, que todavia lleva el angulo de la
   * ronda anterior, lo deshace. El jugador acababa mirando fuera del mapa.
   */

  /** Angulos de spawn del mapa, que apuntan hacia el centro de la arena. */
  const spawnYaws = () => ATRIUM.spawns.map((s) => s.yaw);

  it('el primer snapshot ya pide el angulo del spawn inicial', () => {
    const { session, a, b } = newSession();
    ticks(session, 1);

    expect(a.all('snapshot')[0]!.viewYaw).toBe(ATRIUM.spawns[0].yaw);
    expect(b.all('snapshot')[0]!.viewYaw).toBe(ATRIUM.spawns[1].yaw);
  });

  it('al cambiar de lado cada cliente recibe el angulo de su nuevo spawn', () => {
    const { session, a, b } = newSession();
    goLive(session);

    const yawA = a
      .all('snapshot')
      .filter((s) => s.viewYaw !== undefined)
      .at(-1)!.viewYaw;
    const yawB = b
      .all('snapshot')
      .filter((s) => s.viewYaw !== undefined)
      .at(-1)!.viewYaw;

    // Los dos han cambiado de lado, asi que miran en sentidos opuestos.
    expect(yawA).not.toBe(yawB);
    expect(spawnYaws()).toContain(yawA);
    expect(spawnYaws()).toContain(yawB);

    // Y cada uno es el angulo del spawn donde el servidor le ha puesto.
    const posA = a.last('snapshot')!.players.find((p) => p.id === 1)!;
    const spawnA = ATRIUM.spawns.find((s) => Math.abs(s.pos.x - posA.x) < 1)!;
    expect(yawA).toBe(spawnA.yaw);
  });

  it('el angulo se pide una sola vez, no en cada tick', () => {
    const { session, a } = newSession();
    goLive(session);
    const antes = a.all('snapshot').filter((s) => s.viewYaw !== undefined).length;

    ticks(session, 60);

    expect(a.all('snapshot').filter((s) => s.viewYaw !== undefined).length).toBe(antes);
  });

  it('el angulo pedido corresponde al spawn actual aunque el cliente mande el viejo', () => {
    const { session, a } = newSession();
    const inicial = ATRIUM.spawns[0].yaw;
    goLive(session);

    // El cliente aun no se ha enterado del cambio de lado y sigue mandando el
    // angulo de la ronda anterior: es justo lo que rompia el giro.
    session.handleMessage(1, input([cmd(1, 0, inicial)]));
    ticks(session, 5);

    const me = a.last('snapshot')!.players.find((p) => p.id === 1)!;
    const spawnActual = ATRIUM.spawns.find((s) => Math.abs(s.pos.x - me.x) < 1)!;
    const pedido = a
      .all('snapshot')
      .filter((s) => s.viewYaw !== undefined)
      .at(-1)!.viewYaw;

    expect(pedido).toBe(spawnActual.yaw);
  });

  it('el angulo pedido mira hacia el centro de la arena', () => {
    for (const spawn of ATRIUM.spawns) {
      const world = createCollisionWorld(ATRIUM);
      const state = createMoveState(spawn.pos, spawn.yaw);
      const distanciaInicial = Math.abs(state.pos.x);

      for (let i = 0; i < 64; i++) {
        moveStep(
          state,
          { seq: i, buttons: BUTTON.FORWARD, yaw: spawn.yaw, pitch: 0, dt: TICK_DT },
          world,
        );
      }

      // Avanzar mirando al angulo del spawn acerca al centro del mapa: es lo
      // que garantiza que el jugador aparece mirando al combate y no a la pared.
      expect(Math.abs(state.pos.x)).toBeLessThan(distanciaInicial);
    }
  });
});

describe('pasos audibles', () => {
  /**
   * Corre `count` ticks con el mismo comando y devuelve en que ticks ha sonado
   * un paso del jugador 1.
   */
  const stepTicks = (
    session: MatchSession,
    a: MemoryConnection,
    buttons: number,
    count: number,
  ) => {
    const heard: number[] = [];
    // Con el angulo del spawn: corriendo hacia otro lado se choca con la pared
    // del fondo y no se llega ni a la velocidad de andar.
    const yaw = session.playerOf(1)!.yaw;
    for (let i = 0; i < count; i++) {
      session.handleMessage(1, input([cmd(i + 1, buttons, yaw)]));
      session.update();
      const events = a.last('snapshot')!.events;
      if (events.some((e) => e.t === 'step' && e.id === 1)) heard.push(i);
    }
    return heard;
  };

  it('correr delata la posicion', () => {
    const { session, a } = newSession();
    goLive(session);

    const heard = stepTicks(session, a, BUTTON.FORWARD, 160);
    expect(heard.length).toBeGreaterThan(1);

    // El evento lleva donde ha sonado, que es lo que hace util oirlo.
    const paso = a
      .all('snapshot')
      .flatMap((snap) => snap.events)
      .find((e) => e.t === 'step');
    expect(paso).toMatchObject({ id: 1 });
  });

  it('andar con Shift no delata', () => {
    const { session, a } = newSession();
    goLive(session);
    expect(stepTicks(session, a, BUTTON.FORWARD | BUTTON.WALK, 200)).toEqual([]);
  });

  it('agacharse tampoco', () => {
    const { session, a } = newSession();
    goLive(session);
    expect(stepTicks(session, a, BUTTON.FORWARD | BUTTON.DUCK, 200)).toEqual([]);
  });

  it('quieto no suena', () => {
    const { session, a } = newSession();
    goLive(session);
    expect(stepTicks(session, a, 0, 200)).toEqual([]);
  });
});

describe('estadisticas de la partida', () => {
  /** Deja a los dos enfrentados en el carril sur, que esta despejado. */
  const faceOff = (session: MatchSession) => {
    const shooter = session.playerOf(1)!;
    const target = session.playerOf(2)!;
    shooter.pos = vec3(-700, -300, 0);
    shooter.vel = vec3();
    shooter.onGround = true;
    target.pos = vec3(-300, -300, 0);
    target.vel = vec3();
    target.onGround = true;
    ticks(session, SETTLE_TICKS);
    return { shooter, target };
  };

  /**
   * Devuelve una funcion de disparar que lleva su propia cuenta de secuencia:
   * el servidor descarta los comandos ya vistos, asi que empezar cada tanda
   * desde el numero uno haria que no llegase ninguno.
   */
  const tirador = (session: MatchSession) => {
    let seq = 0;
    return (veces: number, yaw: number) => {
      for (let i = 0; i < veces; i++) {
        seq += 1;
        session.handleMessage(1, input([cmd(seq, BUTTON.ATTACK, yaw, 0)]));
        // Varios ticks por disparo: el rifle tiene tiempo de ciclo.
        for (let t = 0; t < 8; t++) session.update();
      }
    };
  };

  it('la punteria se mide sobre los disparos hechos, no sobre los que aciertan', () => {
    const { session } = newSession();
    goLive(session);
    faceOff(session);

    // Mirando al lado contrario del rival: los cinco disparos se pierden.
    tirador(session)(5, 180);

    const stats = session.statsOf(1);
    expect(stats.shots).toBe(5);
    expect(stats.hits).toBe(0);
    expect(accuracy(stats.hits, stats.shots)).toBe(0);
  });

  it('acertar cuenta como disparo y como acierto', () => {
    const { session } = newSession();
    goLive(session);
    faceOff(session);

    tirador(session)(1, 0);

    const stats = session.statsOf(1);
    expect(stats.shots).toBe(1);
    expect(stats.hits).toBe(1);
    expect(accuracy(stats.hits, stats.shots)).toBe(1);
  });

  it('sin disparar, la punteria es cero y no una division por cero', () => {
    const { session } = newSession();
    goLive(session);
    const stats = session.statsOf(1);
    expect(stats.shots).toBe(0);
    expect(accuracy(stats.hits, stats.shots)).toBe(0);
  });

  it('las estadisticas viajan en la instantanea', () => {
    const { session, a } = newSession();
    goLive(session);
    faceOff(session);

    tirador(session)(2, 180);

    const me = a.last('snapshot')!.players.find((p) => p.id === 1)!;
    expect(me.stats).toMatchObject({ shots: 2, hits: 0 });
  });

  it('matar suma una baja al asesino y una muerte a la victima', () => {
    const { session } = newSession();
    goLive(session);
    const { target } = faceOff(session);

    // A la altura de los ojos y sin dispersion: el disparo va a la cabeza, y
    // con el multiplicador de la cabeza mata de una vez.
    tirador(session)(1, 0);

    expect(target.alive).toBe(false);
    expect(session.statsOf(1).kills).toBe(1);
    expect(session.statsOf(2).deaths).toBe(1);
  });

  it('caerse al vacio no le suma una baja a nadie', () => {
    const { session } = newSession();
    goLive(session);
    const victim = session.playerOf(2)!;
    victim.pos = vec3(0, 0, -100000);

    ticks(session, 2);

    expect(victim.alive).toBe(false);
    expect(session.statsOf(2).deaths).toBe(1);
    expect(session.statsOf(1).kills).toBe(0);
  });

  it('empezar partida nueva pone las estadisticas a cero', () => {
    const { session } = newSession();
    const dispara = tirador(session);

    // Ganar las dos rondas que dura la partida de prueba. Por tiempo no vale:
    // una ronda agotada no da punto a nadie y la partida no acabaria nunca.
    for (let ronda = 0; ronda < 2; ronda++) {
      goLive(session);
      faceOff(session);
      dispara(1, 0);
    }
    expect(session.match.phase).toBe('matchEnd');
    expect(session.statsOf(1).shots).toBe(2);

    let guard = 0;
    while (session.match.phase !== 'warmup' && guard++ < 5000) session.update();

    expect(session.match.phase).toBe('warmup');
    expect(session.statsOf(1)).toMatchObject({ shots: 0, hits: 0, kills: 0, deaths: 0 });
  });
});
