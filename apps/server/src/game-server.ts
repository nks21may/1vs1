/**
 * Emparejamiento y bucle global.
 *
 * Mantiene las sesiones vivas, empareja a los jugadores que llegan y hace
 * avanzar el tiempo. No depende de WebSocket ni de temporizadores: recibe
 * conexiones abstractas y expone `step()`, de modo que una partida entera se
 * puede ejecutar en un test tan rapido como la CPU lo permita.
 */

import {
  type ClientMessage,
  type GameMap,
  type MatchConfig,
  TICK_DT,
} from '@neonduel/shared';

import { BOT_DIFFICULTIES, BotController } from './bot.js';
import { type Connection, MemoryConnection } from './connection.js';
import { MatchSession } from './session.js';

export type BotSkill = keyof typeof BOT_DIFFICULTIES;

export interface GameServerOptions {
  map?: GameMap;
  matchConfig?: MatchConfig;
  /**
   * Semilla de los bots. Por defecto depende del reloj, para que dos partidas
   * seguidas no sean identicas; los tests la fijan para ser reproducibles.
   */
  botSeed?: number;
}

interface SessionEntry {
  session: MatchSession;
  bots: { controller: BotController; connectionId: number }[];
  /** Las partidas contra bots no aceptan a un segundo humano. */
  private: boolean;
}

export class GameServer {
  private readonly sessions: SessionEntry[] = [];
  private readonly sessionByConnection = new Map<number, SessionEntry>();
  private nextConnectionId = 1;

  constructor(private readonly options: GameServerOptions = {}) {}

  get sessionCount(): number {
    return this.sessions.length;
  }

  /** Identificador unico para una conexion entrante. */
  allocateConnectionId(): number {
    return this.nextConnectionId++;
  }

  /**
   * Mete a un jugador en la primera partida con hueco, o crea una nueva.
   *
   * El mapa pedido solo cuenta si acaba creando partida: entrar en una que ya
   * esta en marcha es entrar en el mapa que se este jugando.
   */
  joinMatch(connection: Connection, map?: GameMap): MatchSession {
    const open = this.sessions.find((entry) => !entry.private && !entry.session.isFull);
    const entry = open ?? this.createSession(false, map);

    entry.session.join(connection);
    this.sessionByConnection.set(connection.id, entry);
    return entry.session;
  }

  /** Crea una partida privada contra un bot del nivel indicado. */
  joinBotMatch(connection: Connection, skill: BotSkill = 'normal', map?: GameMap): MatchSession {
    const entry = this.createSession(true, map);
    entry.session.join(connection);
    this.sessionByConnection.set(connection.id, entry);

    const botConnection = new MemoryConnection(
      this.allocateConnectionId(),
      `BOT_${skill.toUpperCase()}`,
      true,
    );
    entry.session.join(botConnection);
    entry.bots.push({
      controller: new BotController(
        botConnection.id,
        // El bot navega el mismo mapa que se esta jugando, no el de por defecto.
        entry.session.map,
        BOT_DIFFICULTIES[skill],
        this.options.botSeed ?? (Date.now() & 0xffff),
      ),
      connectionId: botConnection.id,
    });

    return entry.session;
  }

  handleMessage(connectionId: number, message: ClientMessage): void {
    this.sessionByConnection.get(connectionId)?.session.handleMessage(connectionId, message);
  }

  /** Saca a un jugador y recoge la sesion si se queda sin humanos. */
  leave(connectionId: number): void {
    const entry = this.sessionByConnection.get(connectionId);
    if (!entry) return;

    entry.session.leave(connectionId);
    this.sessionByConnection.delete(connectionId);

    const humansLeft = [...this.sessionByConnection.values()].filter(
      (e) => e === entry,
    ).length;

    if (humansLeft === 0) {
      for (const bot of entry.bots) entry.session.leave(bot.connectionId);
      const index = this.sessions.indexOf(entry);
      if (index !== -1) this.sessions.splice(index, 1);
    }
  }

  sessionOf(connectionId: number): MatchSession | undefined {
    return this.sessionByConnection.get(connectionId)?.session;
  }

  /** Avanza un tick en todas las partidas. */
  step(): void {
    for (const entry of this.sessions) {
      for (const bot of entry.bots) {
        const self = entry.session.playerOf(bot.connectionId);
        if (!self) continue;
        const enemy = entry.session
          .players()
          .find((p) => p.id !== bot.connectionId);
        entry.session.pushCommand(
          bot.connectionId,
          bot.controller.think(self, enemy, !entry.session.match.isLive),
        );
      }
      entry.session.update();
    }
  }

  private createSession(isPrivate: boolean, map?: GameMap): SessionEntry {
    const entry: SessionEntry = {
      session: new MatchSession({
        map: map ?? this.options.map,
        matchConfig: this.options.matchConfig,
      }),
      bots: [],
      private: isPrivate,
    };
    this.sessions.push(entry);
    return entry;
  }
}

/** Intervalo entre ticks en milisegundos. */
export const TICK_INTERVAL = TICK_DT * 1000;
