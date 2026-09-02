import { describe, expect, it } from 'vitest';

import { MAX_REWIND_MS } from '../src/constants.js';
import {
  LagCompensationBuffer,
  computeRewindTime,
  toHitboxTargets,
} from '../src/lagcomp.js';

const frame = (tick: number, timeMs: number, x: number) => ({
  tick,
  timeMs,
  players: [{ id: 1, pos: { x, y: 0, z: 0 }, ducking: false, alive: true }],
});

describe('LagCompensationBuffer', () => {
  it('conserva el orden cronologico', () => {
    const buffer = new LagCompensationBuffer(4);
    for (let i = 0; i < 3; i++) buffer.record(frame(i, i * 16, i * 100));
    expect(buffer.toArray().map((f) => f.tick)).toEqual([0, 1, 2]);
  });

  it('descarta los frames mas antiguos al llenarse', () => {
    const buffer = new LagCompensationBuffer(3);
    for (let i = 0; i < 6; i++) buffer.record(frame(i, i * 16, i * 100));
    expect(buffer.size).toBe(3);
    expect(buffer.toArray().map((f) => f.tick)).toEqual([3, 4, 5]);
    expect(buffer.newest?.tick).toBe(5);
    expect(buffer.oldest?.tick).toBe(3);
  });

  it('interpola entre dos frames', () => {
    const buffer = new LagCompensationBuffer(8);
    buffer.record(frame(0, 0, 0));
    buffer.record(frame(1, 100, 200));

    const samples = buffer.sampleAt(50);
    expect(samples[0]!.pos.x).toBeCloseTo(100, 6);
  });

  it('devuelve el extremo mas cercano fuera del historial', () => {
    const buffer = new LagCompensationBuffer(8);
    buffer.record(frame(0, 100, 10));
    buffer.record(frame(1, 200, 20));

    expect(buffer.sampleAt(0)[0]!.pos.x).toBe(10);
    expect(buffer.sampleAt(9999)[0]!.pos.x).toBe(20);
  });

  it('un buffer vacio no rompe el muestreo', () => {
    expect(new LagCompensationBuffer(4).sampleAt(123)).toEqual([]);
    expect(new LagCompensationBuffer(4).newest).toBeNull();
  });

  it('no interpola los estados discretos', () => {
    const buffer = new LagCompensationBuffer(4);
    buffer.record({
      tick: 0,
      timeMs: 0,
      players: [{ id: 1, pos: { x: 0, y: 0, z: 0 }, ducking: false, alive: true }],
    });
    buffer.record({
      tick: 1,
      timeMs: 100,
      players: [{ id: 1, pos: { x: 0, y: 0, z: 0 }, ducking: true, alive: true }],
    });

    expect(buffer.sampleAt(20)[0]!.ducking).toBe(false);
    expect(buffer.sampleAt(80)[0]!.ducking).toBe(true);
  });

  it('mantiene a los jugadores que solo aparecen en el frame antiguo', () => {
    const buffer = new LagCompensationBuffer(4);
    buffer.record({
      tick: 0,
      timeMs: 0,
      players: [
        { id: 1, pos: { x: 0, y: 0, z: 0 }, ducking: false, alive: true },
        { id: 2, pos: { x: 50, y: 0, z: 0 }, ducking: false, alive: true },
      ],
    });
    buffer.record({
      tick: 1,
      timeMs: 100,
      players: [{ id: 1, pos: { x: 100, y: 0, z: 0 }, ducking: false, alive: true }],
    });

    const samples = buffer.sampleAt(50);
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.id === 2)!.pos.x).toBe(50);
  });
});

describe('computeRewindTime', () => {
  it('retrocede la latencia mas la interpolacion', () => {
    expect(computeRewindTime(1000, 40, 100)).toBe(860);
  });

  it('acota el rebobinado para que no se pueda declarar un ping falso', () => {
    expect(computeRewindTime(1000, 5000, 100)).toBe(1000 - MAX_REWIND_MS);
  });

  it('nunca rebobina hacia el futuro', () => {
    expect(computeRewindTime(1000, -500, 0)).toBe(1000);
  });
});

describe('toHitboxTargets', () => {
  const samples = [
    { id: 1, pos: { x: 0, y: 0, z: 0 }, ducking: false, alive: true },
    { id: 2, pos: { x: 10, y: 0, z: 0 }, ducking: true, alive: true },
    { id: 3, pos: { x: 20, y: 0, z: 0 }, ducking: false, alive: false },
  ];

  it('excluye al tirador y a los muertos', () => {
    const targets = toHitboxTargets(samples, 1);
    expect(targets.map((t) => t.id)).toEqual([2]);
  });

  it('conserva la postura para calcular la hitbox correcta', () => {
    expect(toHitboxTargets(samples, 1)[0]!.ducking).toBe(true);
  });
});
