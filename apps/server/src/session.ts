/**
 * Sesion de partida: una arena 1v1 autoritativa.
 *
 * El servidor es la unica fuente de verdad. Recibe comandos, los simula con la
 * misma fisica que el cliente, resuelve los disparos rebobinando el mundo al
 * instante que veia el tirador y difunde instantaneas.
 *
 * `update()` recibe el tiempo por parametro y no consulta ningun reloj: asi los
 * tests pueden simular una partida completa de forma determinista y sin esperas.
 */

import {
  ATRIUM,
  type ClientMessage,
  DEFAULT_MATCH_CONFIG,
  type GameEvent,
  type GameMap,
  type FootstepTracker,
  HELD_BUTTONS,
  INPUT_BUFFER_SIZE,
  INTERP_DELAY_MS,
  LagCompensationBuffer,
  MAX_COMMANDS_PER_TICK,
  type MatchConfig,
  MatchState,
  PROTOCOL_VERSION,
  type PlayerSnapshot,
  type PlayerState,
  type PlayerStats,
  SNAPSHOT_FLAG,
  type ShotRequest,
  TICK_DT,
  TICK_RATE,
  type UserCommand,
  advanceFootstep,
  applyDamage,
  applyPhaseRestrictions,
  computeDamage,
  computeRewindTime,
  createCollisionWorld,
  createFootstepTracker,
  createPlayer,
  getWeapon,
  length2D,
  respawnPlayer,
  round2,
  shotDirection,
  simulatePlayerTick,
  toHitboxTargets,
  traceHitscan,
} from '@neonduel/shared';

import type { Connection } from './connection.js';

export interface SessionOptions {
  map?: GameMap;
  matchConfig?: MatchConfig;
  matchId?: string;
}

interface Participant {
  connection: Connection;
  player: PlayerState;
  /** Comandos pendientes de simular, en orden de llegada. */
  queue: UserCommand[];
  /** Ultima secuencia procesada; se devuelve en el snapshot para reconciliar. */
  lastProcessedSeq: number;
  /** Mayor secuencia vista: descarta duplicados y reenvios. */
  highestSeq: number;
  /** Ultimo comando simulado, que se repite si el buffer se queda vacio. */
  lastCommand: UserCommand;
  latencyMs: number;
  interpMs: number;
  /** Indice del punto de aparicion, alternado cada ronda. */
  spawnSlot: number;
  /**
   * Angulo que el cliente debe adoptar en el proximo snapshot, o `null`.
   * Se llena al reaparecer y se vacia en cuanto se envia.
   */
  pendingViewYaw: number | null;
  /** Zancada acumulada, para saber cuando toca que suene una pisada. */
  footsteps: FootstepTracker;
  /** Bajas, muertes y punteria de toda la partida. */
  stats: PlayerStats;
}

export class MatchSession {
  readonly matchId: string;
  readonly map: GameMap;
  readonly match: MatchState;

  private readonly world;
  private readonly participants = new Map<number, Participant>();
  private readonly history = new LagCompensationBuffer();
  private pendingEvents: GameEvent[] = [];

  tick = 0;
  timeMs = 0;

  constructor(options: SessionOptions = {}) {
    this.map = options.map ?? ATRIUM;
    this.world = createCollisionWorld(this.map);
    this.match = new MatchState(options.matchConfig ?? DEFAULT_MATCH_CONFIG);
    this.matchId = options.matchId ?? `m${Math.random().toString(36).slice(2, 8)}`;
  }

  get playerCount(): number {
    return this.participants.size;
  }

  get isFull(): boolean {
    return this.participants.size >= 2;
  }

  get isEmpty(): boolean {
    return this.participants.size === 0;
  }

  players(): PlayerState[] {
    return [...this.participants.values()].map((p) => p.player);
  }

  playerOf(connectionId: number): PlayerState | undefined {
    return this.participants.get(connectionId)?.player;
  }

  /** Estadisticas de un jugador. Si no esta, un cero que no rompe nada. */
  statsOf(playerId: number): PlayerStats {
    return this.participants.get(playerId)?.stats ?? { kills: 0, deaths: 0, shots: 0, hits: 0 };
  }

  /** Anade un jugador y le envia el mensaje de bienvenida. */
  join(connection: Connection): PlayerState {
    const slot = this.participants.size % 2;
    const spawn = this.map.spawns[slot]!;
    const player = createPlayer(connection.id, connection.name, spawn.pos, spawn.yaw);

    this.participants.set(connection.id, {
      connection,
      player,
      queue: [],
      lastProcessedSeq: 0,
      highestSeq: -1,
      lastCommand: { seq: 0, buttons: 0, yaw: spawn.yaw, pitch: 0, dt: TICK_DT },
      latencyMs: 0,
      interpMs: INTERP_DELAY_MS,
      spawnSlot: slot,
      pendingViewYaw: spawn.yaw,
      footsteps: createFootstepTracker(),
      stats: { kills: 0, deaths: 0, shots: 0, hits: 0 },
    });

    connection.send({
      t: 'welcome',
      playerId: connection.id,
      mapName: this.map.name,
      tickRate: TICK_RATE,
      matchId: this.matchId,
      version: PROTOCOL_VERSION,
    });

    this.handleMatchEvents(this.match.addPlayer(connection.id));
    return player;
  }

  leave(connectionId: number): void {
    if (!this.participants.delete(connectionId)) return;
    this.handleMatchEvents(this.match.removePlayer(connectionId));
  }

  /** Procesa un mensaje ya validado por el protocolo. */
  handleMessage(connectionId: number, message: ClientMessage): void {
    const participant = this.participants.get(connectionId);
    if (!participant) return;

    switch (message.t) {
      case 'join':
        participant.player.name = message.name;
        participant.connection.name = message.name;
        break;

      case 'input': {
        participant.interpMs = message.interp;
        // La latencia declarada solo se usa para rebobinar, y ahi va acotada.
        participant.latencyMs = message.rtt / 2;
        for (const cmd of message.cmds) {
          // Los comandos se reenvian por redundancia: solo interesan los nuevos.
          if (cmd.seq <= participant.highestSeq) continue;
          participant.highestSeq = cmd.seq;
          participant.queue.push(cmd);
        }
        // Un cliente que inunda no puede hacer crecer la memoria sin limite.
        if (participant.queue.length > INPUT_BUFFER_SIZE) {
          participant.queue.splice(0, participant.queue.length - INPUT_BUFFER_SIZE);
        }
        break;
      }

      case 'ping':
        participant.connection.send({
          t: 'pong',
          time: message.time,
          server: this.timeMs,
        });
        break;
    }
  }

  /** Inyecta comandos directamente: lo usan los bots, que no pasan por la red. */
  pushCommand(connectionId: number, cmd: UserCommand): void {
    const participant = this.participants.get(connectionId);
    if (!participant) return;
    participant.highestSeq = Math.max(participant.highestSeq, cmd.seq);
    participant.queue.push(cmd);
  }

  /** Avanza exactamente un tick de simulacion. */
  update(): void {
    this.tick += 1;
    this.timeMs += TICK_DT * 1000;

    this.handleMatchEvents(this.match.update(TICK_DT));

    const frozen = this.match.isFrozen || this.match.phase !== 'live';
    for (const participant of this.participants.values()) {
      this.simulateParticipant(participant, frozen);
    }

    this.recordHistory();
    this.broadcastSnapshots();
    this.pendingEvents = [];
  }

  private simulateParticipant(participant: Participant, frozen: boolean): void {
    const { player } = participant;

    // Se procesan varios comandos por tick para que un cliente con un pico de
    // latencia pueda ponerse al dia, pero con tope: si no, recuperar el retraso
    // se convertiria en moverse mas rapido que los demas.
    const count = Math.min(participant.queue.length, MAX_COMMANDS_PER_TICK);
    const commands =
      count > 0
        ? participant.queue.splice(0, count)
        : // Sin comandos nuevos repetimos el ultimo, pero solo con la postura:
          // la gravedad debe seguir aplicandose aunque el cliente deje de
          // hablar, y nadie quiere que el servidor dispare o avance en su
          // nombre. La postura si se conserva porque el jugador la sigue
          // manteniendo en su pantalla: borrarla dejaba al servidor levantando
          // a un jugador agachado durante los huecos normales del jitter, con
          // la velocidad maxima disparandose de 73 a 215 u/s y la correccion
          // resultante sacudiendo la camara.
          [
            {
              ...participant.lastCommand,
              buttons: participant.lastCommand.buttons & HELD_BUTTONS,
              slot: 0,
              dt: TICK_DT,
            },
          ];

    for (const rawCmd of commands) {
      const cmd = applyPhaseRestrictions(rawCmd, frozen);
      const events = simulatePlayerTick(player, cmd, this.world);

      participant.lastCommand = cmd;
      if (count > 0) participant.lastProcessedSeq = rawCmd.seq;

      if (events.shot) this.resolveShot(participant, events.shot);
      if (events.jumped) this.pendingEvents.push({ t: 'jump', id: player.id });
      if (events.landed) {
        this.pendingEvents.push({
          t: 'land',
          id: player.id,
          speed: round2(events.landingSpeed),
        });
      }
      // Los pasos van por distancia recorrida, no por tiempo: asi la cadencia
      // sale sola de la velocidad y andar o agacharse no suenan.
      if (
        player.alive &&
        advanceFootstep(participant.footsteps, length2D(player.vel), player.onGround, cmd.dt)
      ) {
        this.pendingEvents.push({
          t: 'step',
          id: player.id,
          x: round2(player.pos.x),
          y: round2(player.pos.y),
          z: round2(player.pos.z),
        });
      }
      if (events.startedReload) this.pendingEvents.push({ t: 'reload', id: player.id });
      if (events.switchedWeapon) {
        this.pendingEvents.push({ t: 'switch', id: player.id, weapon: player.weapon });
      }
    }

    // Salvaguarda: caer fuera del mapa mata.
    if (player.alive && player.pos.z < this.map.killZ) {
      this.killPlayer(player, null, null);
    }
  }

  /**
   * Resuelve un disparo rebobinando a los rivales al instante que el tirador
   * veia en su pantalla.
   */
  private resolveShot(participant: Participant, shot: ShotRequest): void {
    const rewindTime = computeRewindTime(
      this.timeMs,
      participant.latencyMs,
      participant.interpMs,
    );
    // El historial solo llega hasta el tick anterior. Si no hay nada que
    // compensar (cliente local, o latencia declarada nula) se dispara contra el
    // estado presente en lugar de arrastrar un tick de desfase artificial.
    const newest = this.history.newest;
    const useLiveState = !newest || rewindTime >= newest.timeMs;
    const rewound = useLiveState ? [] : this.history.sampleAt(rewindTime);

    const targets =
      rewound.length > 0
        ? toHitboxTargets(rewound, participant.player.id)
        : this.players()
            .filter((p) => p.id !== participant.player.id && p.alive)
            .map((p) => ({ id: p.id, pos: p.pos, ducking: p.ducking }));

    const weapon = getWeapon(shot.weapon);
    const dir = shotDirection(shot.yaw, shot.pitch);
    const result = traceHitscan(this.world, targets, shot.origin, dir, weapon.range);

    // Se cuenta aqui, antes de saber en que acaba: la punteria se mide sobre
    // los disparos hechos, asi que fallar contra una pared tambien cuenta.
    participant.stats.shots += 1;

    this.pendingEvents.push({
      t: 'shot',
      id: participant.player.id,
      weapon: shot.weapon,
      ox: round2(shot.origin.x),
      oy: round2(shot.origin.y),
      oz: round2(shot.origin.z),
      ex: round2(result.endPos.x),
      ey: round2(result.endPos.y),
      ez: round2(result.endPos.z),
    });

    if (result.hitWorld) {
      this.pendingEvents.push({
        t: 'impact',
        x: round2(result.endPos.x),
        y: round2(result.endPos.y),
        z: round2(result.endPos.z),
        nx: result.normal.x,
        ny: result.normal.y,
        nz: result.normal.z,
      });
      return;
    }

    if (result.playerId === null || result.hitGroup === null) return;

    const victim = this.participants.get(result.playerId)?.player;
    if (!victim || !victim.alive) return;

    participant.stats.hits += 1;

    const damage = computeDamage(weapon, result.hitGroup, result.distance);
    const killed = applyDamage(victim, damage);

    this.pendingEvents.push({
      t: 'hit',
      attacker: participant.player.id,
      victim: victim.id,
      group: result.hitGroup,
      damage,
      x: round2(result.endPos.x),
      y: round2(result.endPos.y),
      z: round2(result.endPos.z),
    });

    if (killed) this.killPlayer(victim, participant.player.id, result.hitGroup);
  }

  private killPlayer(
    victim: PlayerState,
    killerId: number | null,
    group: 'head' | 'chest' | 'legs' | null,
  ): void {
    victim.alive = false;
    victim.health = 0;
    this.statsOf(victim.id).deaths += 1;
    // Matarse solo (el vacio) no suma una baja a nadie.
    if (killerId !== null && killerId !== victim.id) this.statsOf(killerId).kills += 1;
    this.pendingEvents.push({ t: 'death', victim: victim.id, killer: killerId, group });
    this.handleMatchEvents(this.match.reportDeath(victim.id));
  }

  private handleMatchEvents(events: ReturnType<MatchState['update']>): void {
    for (const event of events) {
      switch (event.type) {
        case 'roundStart':
          this.respawnAll(event.round);
          this.pendingEvents.push({ t: 'roundStart', round: event.round });
          break;
        case 'roundEnd':
          this.pendingEvents.push({
            t: 'roundEnd',
            round: event.round,
            winnerId: event.winnerId,
            reason: event.reason,
          });
          break;
        case 'matchEnd':
          this.pendingEvents.push({ t: 'matchEnd', winnerId: event.winnerId });
          break;
        case 'phase':
          // Entrar en calentamiento es empezar partida nueva: las estadisticas
          // son de la partida, no de la sesion, y arrastrarlas falsearia la
          // punteria de la siguiente.
          if (event.phase === 'warmup') {
            for (const participant of this.participants.values()) {
              participant.stats = { kills: 0, deaths: 0, shots: 0, hits: 0 };
            }
          }
          break;
        default:
          break;
      }
    }
  }

  /** Reinicia a los dos jugadores intercambiando los lados cada ronda. */
  private respawnAll(round: number): void {
    for (const participant of this.participants.values()) {
      const index = (participant.spawnSlot + round) % this.map.spawns.length;
      const spawn = this.map.spawns[index]!;
      respawnPlayer(participant.player, spawn.pos, spawn.yaw);
      participant.lastCommand = {
        ...participant.lastCommand,
        buttons: 0,
        yaw: spawn.yaw,
        pitch: 0,
      };
      // Girar al jugador en el servidor no basta: el proximo comando del cliente
      // trae el angulo anterior y lo deshace. Hay que pedirle el giro.
      participant.pendingViewYaw = spawn.yaw;
    }
  }

  private recordHistory(): void {
    this.history.record({
      tick: this.tick,
      timeMs: this.timeMs,
      players: this.players().map((p) => ({
        id: p.id,
        pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
        ducking: p.ducking,
        alive: p.alive,
      })),
    });
  }

  private snapshotOf(player: PlayerState): PlayerSnapshot {
    const weapon = getWeapon(player.weapon);
    let flags = 0;
    if (player.ducking) flags |= SNAPSHOT_FLAG.DUCKING;
    if (player.onGround) flags |= SNAPSHOT_FLAG.ON_GROUND;
    if (player.alive) flags |= SNAPSHOT_FLAG.ALIVE;

    return {
      id: player.id,
      name: player.name,
      x: round2(player.pos.x),
      y: round2(player.pos.y),
      z: round2(player.pos.z),
      vx: round2(player.vel.x),
      vy: round2(player.vel.y),
      vz: round2(player.vel.z),
      yaw: round2(player.yaw),
      pitch: round2(player.pitch),
      flags,
      duck: round2(player.duckProgress),
      health: player.health,
      weapon: player.weapon,
      ammo: player.ammo[player.weapon],
      reload:
        player.reloadRemaining > 0
          ? round2(1 - player.reloadRemaining / weapon.reloadTime)
          : 0,
      score: this.match.scoreOf(player.id),
      stats: { ...this.statsOf(player.id) },
    };
  }

  private broadcastSnapshots(): void {
    const players = this.players().map((p) => this.snapshotOf(p));

    for (const participant of this.participants.values()) {
      if (participant.connection.isBot) {
        participant.pendingViewYaw = null;
        continue;
      }

      // Cada cliente recibe marcados como `local` los disparos que ya predijo,
      // para no dibujar dos veces el mismo trazador.
      const events = this.pendingEvents.map((event) =>
        event.t === 'shot' && event.id === participant.player.id
          ? { ...event, local: true }
          : event,
      );

      participant.connection.send({
        t: 'snapshot',
        ...(participant.pendingViewYaw === null
          ? {}
          : { viewYaw: participant.pendingViewYaw }),
        tick: this.tick,
        time: round2(this.timeMs),
        ack: participant.lastProcessedSeq,
        players,
        phase: this.match.phase,
        phaseTime: round2(Math.max(0, this.match.phaseRemaining)),
        round: this.match.round,
        events,
      });
      participant.pendingViewYaw = null;
    }
  }
}
