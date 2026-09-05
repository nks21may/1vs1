import { describe, expect, it } from 'vitest';

import {
  ATRIUM,
  BUTTON,
  DEFAULT_MATCH_CONFIG,
  createPlayer,
  hasButton,
  vec3,
} from '@neonduel/shared';

import { BOT_DIFFICULTIES, BotController } from '../src/bot.js';
import { MemoryConnection } from '../src/connection.js';
import { GameServer } from '../src/game-server.js';

const config = { ...DEFAULT_MATCH_CONFIG, roundsToWin: 2 };

describe('emparejamiento', () => {
  it('junta a los dos primeros jugadores en la misma partida', () => {
    const server = new GameServer({ matchConfig: config });
    const a = new MemoryConnection(server.allocateConnectionId());
    const b = new MemoryConnection(server.allocateConnectionId());

    const sessionA = server.joinMatch(a);
    const sessionB = server.joinMatch(b);

    expect(sessionA).toBe(sessionB);
    expect(server.sessionCount).toBe(1);
    expect(sessionA.playerCount).toBe(2);
  });

  it('abre una partida nueva cuando la anterior esta llena', () => {
    const server = new GameServer({ matchConfig: config });
    for (let i = 0; i < 3; i++) {
      server.joinMatch(new MemoryConnection(server.allocateConnectionId()));
    }
    expect(server.sessionCount).toBe(2);
  });

  it('una partida contra bot es privada: nadie mas entra', () => {
    const server = new GameServer({ matchConfig: config });
    const solo = new MemoryConnection(server.allocateConnectionId());
    const botSession = server.joinBotMatch(solo, 'normal');
    expect(botSession.playerCount).toBe(2);

    const other = new MemoryConnection(server.allocateConnectionId());
    expect(server.joinMatch(other)).not.toBe(botSession);
  });

  it('al bot no se le envian instantaneas', () => {
    const server = new GameServer({ matchConfig: config });
    const human = new MemoryConnection(server.allocateConnectionId());
    server.joinBotMatch(human, 'easy');
    server.step();

    expect(human.all('snapshot')).toHaveLength(1);
  });

  it('la partida se recoge cuando se va el ultimo humano', () => {
    const server = new GameServer({ matchConfig: config });
    const human = new MemoryConnection(server.allocateConnectionId());
    server.joinBotMatch(human, 'easy');
    expect(server.sessionCount).toBe(1);

    server.leave(human.id);
    expect(server.sessionCount).toBe(0);
  });

  it('la partida sigue viva mientras quede un humano', () => {
    const server = new GameServer({ matchConfig: config });
    const a = new MemoryConnection(server.allocateConnectionId());
    const b = new MemoryConnection(server.allocateConnectionId());
    server.joinMatch(a);
    server.joinMatch(b);

    server.leave(b.id);
    expect(server.sessionCount).toBe(1);
    expect(server.sessionOf(a.id)?.playerCount).toBe(1);
  });

  it('salir sin haber entrado no rompe nada', () => {
    const server = new GameServer({ matchConfig: config });
    expect(() => server.leave(1234)).not.toThrow();
  });

  it('step avanza todas las partidas a la vez', () => {
    const server = new GameServer({ matchConfig: config });
    const a = new MemoryConnection(server.allocateConnectionId());
    const b = new MemoryConnection(server.allocateConnectionId());
    server.joinMatch(a);
    server.joinBotMatch(b, 'normal');

    server.step();
    server.step();

    expect(a.all('snapshot')).toHaveLength(2);
    expect(b.all('snapshot')).toHaveLength(2);
  });
});

describe('bot', () => {
  const bot = (skill: keyof typeof BOT_DIFFICULTIES = 'normal') =>
    new BotController(2, ATRIUM, BOT_DIFFICULTIES[skill], 1234);

  const players = () => {
    const self = createPlayer(2, 'BOT', vec3(-700, -300, 0));
    const enemy = createPlayer(1, 'HUMANO', vec3(-300, -300, 0));
    self.onGround = true;
    enemy.onGround = true;
    return { self, enemy };
  };

  it('genera comandos con secuencia creciente y dt de un tick', () => {
    const controller = bot();
    const { self, enemy } = players();
    const first = controller.think(self, enemy, false);
    const second = controller.think(self, enemy, false);

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(first.dt).toBeCloseTo(1 / 64, 9);
  });

  it('no hace nada durante las fases congeladas', () => {
    const controller = bot();
    const { self, enemy } = players();
    expect(controller.think(self, enemy, true).buttons).toBe(0);
  });

  it('no actua si esta muerto', () => {
    const controller = bot();
    const { self, enemy } = players();
    self.alive = false;
    expect(controller.think(self, enemy, false).buttons).toBe(0);
  });

  it('gira hacia el rival cuando lo ve', () => {
    const controller = bot();
    const { self, enemy } = players();
    // El bot mira al lado contrario al empezar.
    self.yaw = 180;

    let cmd = controller.think(self, enemy, false);
    for (let i = 0; i < 60; i++) {
      self.yaw = cmd.yaw;
      self.pitch = cmd.pitch;
      cmd = controller.think(self, enemy, false);
    }
    // El rival esta hacia +X, es decir yaw ~ 0.
    expect(Math.abs(cmd.yaw)).toBeLessThan(15);
  });

  it('acaba disparando tras su tiempo de reaccion', () => {
    const controller = bot('hard');
    const { self, enemy } = players();
    self.yaw = 0;

    let fired = false;
    for (let i = 0; i < 120; i++) {
      const cmd = controller.think(self, enemy, false);
      self.yaw = cmd.yaw;
      self.pitch = cmd.pitch;
      if (hasButton(cmd.buttons, BUTTON.ATTACK)) {
        fired = true;
        break;
      }
    }
    expect(fired).toBe(true);
  });

  it('no dispara a traves de una pared', () => {
    const controller = bot('hard');
    const self = createPlayer(2, 'BOT', vec3(-600, 0, 0));
    const enemy = createPlayer(1, 'HUMANO', vec3(600, 0, 0));
    self.onGround = true;
    enemy.onGround = true;

    let fired = false;
    for (let i = 0; i < 120; i++) {
      const cmd = controller.think(self, enemy, false);
      self.yaw = cmd.yaw;
      self.pitch = cmd.pitch;
      if (hasButton(cmd.buttons, BUTTON.ATTACK)) fired = true;
    }
    // El monolito central corta la linea de vision.
    expect(fired).toBe(false);
  });

  it('recarga cuando se queda sin balas', () => {
    const controller = bot();
    const { self, enemy } = players();
    self.ammo.rifle = 0;
    const cmd = controller.think(self, enemy, false);
    expect(hasButton(cmd.buttons, BUTTON.RELOAD)).toBe(true);
  });

  it('avanza para buscar al rival cuando no lo ve', () => {
    const controller = bot();
    const self = createPlayer(2, 'BOT', vec3(-600, 0, 0));
    const enemy = createPlayer(1, 'HUMANO', vec3(600, 0, 0));
    self.onGround = true;
    enemy.onGround = true;

    const cmd = controller.think(self, enemy, false);
    expect(hasButton(cmd.buttons, BUTTON.FORWARD)).toBe(true);
  });

  it('los niveles de dificultad estan ordenados', () => {
    expect(BOT_DIFFICULTIES.easy.aimError).toBeGreaterThan(BOT_DIFFICULTIES.hard.aimError);
    expect(BOT_DIFFICULTIES.easy.reactionTime).toBeGreaterThan(BOT_DIFFICULTIES.hard.reactionTime);
    expect(BOT_DIFFICULTIES.hard.turnSpeed).toBeGreaterThan(BOT_DIFFICULTIES.easy.turnSpeed);
  });
});

describe('partida completa contra un bot', () => {
  it('llega a su fin sin lanzar errores y con un ganador', () => {
    // Semilla fija: sin ella el bot juega distinto en cada ejecucion y el test
    // pasaria o fallaria segun el reloj.
    const server = new GameServer({
      matchConfig: { ...DEFAULT_MATCH_CONFIG, roundsToWin: 1, roundSeconds: 45 },
      botSeed: 0xd4e1,
    });
    const human = new MemoryConnection(server.allocateConnectionId());
    const session = server.joinBotMatch(human, 'hard');

    // 90 segundos de juego a 64 Hz. Se mira si en algun momento hubo ganador y
    // no como acaba el reloj: al terminar una partida empieza otra, asi que
    // preguntar solo al final hace que el test dependa de lo rapido que sea el
    // bot, que es justo lo que no se esta probando aqui.
    let huboGanador = false;
    for (let i = 0; i < 64 * 90; i++) {
      server.step();
      if (session.match.matchWinner !== null) huboGanador = true;
    }

    expect(huboGanador).toBe(true);
    expect(human.all('snapshot').length).toBeGreaterThan(1000);
    expect(session.map).toBe(ATRIUM);
  });
});
