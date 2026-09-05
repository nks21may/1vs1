import { describe, expect, it } from 'vitest';

import { DEFAULT_MATCH_CONFIG, MatchState, type MatchEvent } from '../src/match.js';

const config = { ...DEFAULT_MATCH_CONFIG, roundsToWin: 3 };

const newMatch = () => {
  const match = new MatchState(config);
  match.addPlayer(1);
  match.addPlayer(2);
  return match;
};

/** Avanza el reloj hasta que la fase actual termina. */
const skipPhase = (match: MatchState): MatchEvent[] => match.update(match.phaseRemaining + 0.001);

/** Lleva la partida hasta la fase 'live'. */
const goLive = (match: MatchState) => {
  while (match.phase !== 'live') skipPhase(match);
};

describe('inicio de partida', () => {
  it('espera hasta tener dos jugadores', () => {
    const match = new MatchState(config);
    match.addPlayer(1);
    expect(match.phase).toBe('waiting');
    match.addPlayer(2);
    expect(match.phase).toBe('warmup');
  });

  it('ignora a un jugador duplicado', () => {
    const match = newMatch();
    expect(match.addPlayer(1)).toEqual([]);
    expect(match.players).toHaveLength(2);
  });

  it('en espera el reloj no avanza', () => {
    const match = new MatchState(config);
    match.addPlayer(1);
    expect(match.update(10)).toEqual([]);
    expect(match.phase).toBe('waiting');
  });

  it('la secuencia de fases es warmup -> freeze -> live', () => {
    const match = newMatch();
    expect(match.phase).toBe('warmup');
    skipPhase(match);
    expect(match.phase).toBe('freeze');
    expect(match.round).toBe(1);
    expect(match.isFrozen).toBe(true);
    skipPhase(match);
    expect(match.phase).toBe('live');
    expect(match.isLive).toBe(true);
  });
});

describe('resolucion de rondas', () => {
  it('una muerte da la ronda al superviviente', () => {
    const match = newMatch();
    goLive(match);

    const events = match.reportDeath(2);
    expect(events[0]).toEqual({
      type: 'roundEnd',
      round: 1,
      winnerId: 1,
      reason: 'elimination',
    });
    expect(match.scoreOf(1)).toBe(1);
    expect(match.scoreOf(2)).toBe(0);
    expect(match.phase).toBe('roundEnd');
  });

  it('agotar el tiempo no puntua para nadie', () => {
    const match = newMatch();
    goLive(match);

    const events = skipPhase(match);
    const roundEnd = events.find((e) => e.type === 'roundEnd');
    expect(roundEnd).toMatchObject({ winnerId: null, reason: 'timeout' });
    expect(match.scoreOf(1)).toBe(0);
    expect(match.scoreOf(2)).toBe(0);
  });

  it('una muerte fuera de la ronda en vivo no cuenta', () => {
    const match = newMatch();
    expect(match.reportDeath(2)).toEqual([]);
    expect(match.scoreOf(1)).toBe(0);
  });

  it('tras el intermedio empieza la ronda siguiente', () => {
    const match = newMatch();
    goLive(match);
    match.reportDeath(2);
    skipPhase(match);
    expect(match.round).toBe(2);
    expect(match.phase).toBe('freeze');
  });
});

describe('fin de partida', () => {
  it('gana quien llega a las rondas configuradas', () => {
    const match = newMatch();
    let events: MatchEvent[] = [];

    for (let i = 0; i < config.roundsToWin; i++) {
      goLive(match);
      events = match.reportDeath(2);
      if (match.phase === 'matchEnd') break;
      skipPhase(match);
    }

    expect(match.scoreOf(1)).toBe(config.roundsToWin);
    expect(match.matchWinner).toBe(1);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
    expect(match.phase).toBe('matchEnd');
  });

  it('tras el fin de partida el marcador se reinicia', () => {
    const match = newMatch();
    for (let i = 0; i < config.roundsToWin; i++) {
      goLive(match);
      match.reportDeath(2);
      if (match.phase === 'matchEnd') break;
      skipPhase(match);
    }

    skipPhase(match);
    expect(match.phase).toBe('warmup');
    expect(match.scoreOf(1)).toBe(0);
    expect(match.round).toBe(0);
    expect(match.matchWinner).toBeNull();
  });

  it('si alguien se va, el rival gana por abandono', () => {
    const match = newMatch();
    goLive(match);

    const events = match.removePlayer(2);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(true);
    expect(match.matchWinner).toBe(1);
    expect(events.find((e) => e.type === 'roundEnd')).toMatchObject({ reason: 'forfeit' });
  });

  it('quitar a alguien que no juega no cambia nada', () => {
    const match = newMatch();
    expect(match.removePlayer(99)).toEqual([]);
    expect(match.players).toHaveLength(2);
  });

  it('si se queda vacia vuelve a espera', () => {
    const match = newMatch();
    goLive(match);
    match.removePlayer(2);
    match.removePlayer(1);
    skipPhase(match);
    expect(match.phase).toBe('waiting');
  });
});
