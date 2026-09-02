/**
 * Reglas de la partida 1v1: fases, rondas y marcador.
 *
 * Deliberadamente no sabe nada de sockets ni de jugadores concretos (solo
 * maneja identificadores numericos), para poder simular una partida completa en
 * los tests sin levantar un servidor.
 */

import {
  FREEZE_TIME_SECONDS,
  MATCH_END_SECONDS,
  ROUNDS_TO_WIN,
  ROUND_END_SECONDS,
  ROUND_TIME_SECONDS,
  WARMUP_SECONDS,
} from './constants.js';

export type MatchPhase =
  | 'waiting'
  | 'warmup'
  | 'freeze'
  | 'live'
  | 'roundEnd'
  | 'matchEnd';

export type MatchEvent =
  | { type: 'phase'; phase: MatchPhase }
  | { type: 'roundStart'; round: number }
  | { type: 'roundEnd'; round: number; winnerId: number | null; reason: RoundEndReason }
  | { type: 'matchEnd'; winnerId: number | null };

export type RoundEndReason = 'elimination' | 'timeout' | 'forfeit';

export interface MatchConfig {
  roundsToWin: number;
  warmupSeconds: number;
  freezeSeconds: number;
  roundSeconds: number;
  roundEndSeconds: number;
  matchEndSeconds: number;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  roundsToWin: ROUNDS_TO_WIN,
  warmupSeconds: WARMUP_SECONDS,
  freezeSeconds: FREEZE_TIME_SECONDS,
  roundSeconds: ROUND_TIME_SECONDS,
  roundEndSeconds: ROUND_END_SECONDS,
  matchEndSeconds: MATCH_END_SECONDS,
};

export class MatchState {
  phase: MatchPhase = 'waiting';
  /** Segundos que faltan para que termine la fase actual. */
  phaseRemaining = 0;
  round = 0;
  readonly scores = new Map<number, number>();
  /** Ganador de la ultima ronda resuelta. */
  lastRoundWinner: number | null = null;
  matchWinner: number | null = null;

  private readonly playerIds: number[] = [];

  constructor(private readonly config: MatchConfig = DEFAULT_MATCH_CONFIG) {}

  get players(): readonly number[] {
    return this.playerIds;
  }

  /** True si los jugadores pueden moverse y disparar. */
  get isLive(): boolean {
    return this.phase === 'live';
  }

  /** True si la fase congela a los jugadores en su spawn. */
  get isFrozen(): boolean {
    return this.phase === 'freeze' || this.phase === 'warmup';
  }

  scoreOf(playerId: number): number {
    return this.scores.get(playerId) ?? 0;
  }

  addPlayer(playerId: number): MatchEvent[] {
    if (this.playerIds.includes(playerId)) return [];
    this.playerIds.push(playerId);
    this.scores.set(playerId, this.scores.get(playerId) ?? 0);

    if (this.phase === 'waiting' && this.playerIds.length >= 2) {
      return this.enterPhase('warmup', this.config.warmupSeconds);
    }
    return [];
  }

  /** Saca a un jugador; con menos de dos la partida vuelve a espera. */
  removePlayer(playerId: number): MatchEvent[] {
    const index = this.playerIds.indexOf(playerId);
    if (index === -1) return [];
    this.playerIds.splice(index, 1);

    const events: MatchEvent[] = [];
    if (this.phase !== 'waiting' && this.phase !== 'matchEnd') {
      const remaining = this.playerIds[0] ?? null;
      events.push({
        type: 'roundEnd',
        round: this.round,
        winnerId: remaining,
        reason: 'forfeit',
      });
      events.push({ type: 'matchEnd', winnerId: remaining });
      this.matchWinner = remaining;
      events.push(...this.enterPhase('matchEnd', this.config.matchEndSeconds));
    }
    return events;
  }

  /** Notifica una muerte durante la ronda en juego. */
  reportDeath(victimId: number): MatchEvent[] {
    if (this.phase !== 'live') return [];
    const winner = this.playerIds.find((id) => id !== victimId) ?? null;
    return this.finishRound(winner, 'elimination');
  }

  /** Avanza el reloj de la partida. */
  update(dt: number): MatchEvent[] {
    if (this.phase === 'waiting') return [];

    this.phaseRemaining -= dt;
    if (this.phaseRemaining > 0) return [];

    switch (this.phase) {
      case 'warmup':
      case 'roundEnd':
        return this.startRound();
      case 'freeze':
        return this.enterPhase('live', this.config.roundSeconds);
      case 'live':
        return this.finishRound(null, 'timeout');
      case 'matchEnd':
        return this.resetMatch();
      default:
        return [];
    }
  }

  private startRound(): MatchEvent[] {
    if (this.playerIds.length < 2) {
      return this.enterPhase('waiting', 0);
    }
    this.round += 1;
    const events = this.enterPhase('freeze', this.config.freezeSeconds);
    events.push({ type: 'roundStart', round: this.round });
    return events;
  }

  private finishRound(winnerId: number | null, reason: RoundEndReason): MatchEvent[] {
    this.lastRoundWinner = winnerId;
    if (winnerId !== null) {
      this.scores.set(winnerId, this.scoreOf(winnerId) + 1);
    }

    const events: MatchEvent[] = [
      { type: 'roundEnd', round: this.round, winnerId, reason },
    ];

    if (winnerId !== null && this.scoreOf(winnerId) >= this.config.roundsToWin) {
      this.matchWinner = winnerId;
      events.push({ type: 'matchEnd', winnerId });
      events.push(...this.enterPhase('matchEnd', this.config.matchEndSeconds));
    } else {
      events.push(...this.enterPhase('roundEnd', this.config.roundEndSeconds));
    }
    return events;
  }

  private resetMatch(): MatchEvent[] {
    this.round = 0;
    this.matchWinner = null;
    this.lastRoundWinner = null;
    for (const id of this.playerIds) this.scores.set(id, 0);
    if (this.playerIds.length >= 2) {
      return this.enterPhase('warmup', this.config.warmupSeconds);
    }
    return this.enterPhase('waiting', 0);
  }

  private enterPhase(phase: MatchPhase, seconds: number): MatchEvent[] {
    this.phase = phase;
    this.phaseRemaining = seconds;
    return [{ type: 'phase', phase }];
  }
}
