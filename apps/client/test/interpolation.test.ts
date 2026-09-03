import { describe, expect, it } from 'vitest';

import { SNAPSHOT_FLAG, type PlayerSnapshot } from '@neonduel/shared';

import { InterpolationBuffer } from '../src/game/interpolation.js';

const player = (id: number, x: number, yaw = 0, flags = SNAPSHOT_FLAG.ALIVE): PlayerSnapshot => ({
  id,
  name: `P${id}`,
  x,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw,
  pitch: 0,
  flags,
  health: 100,
  weapon: 'rifle',
  ammo: 30,
  reload: 0,
  score: 0,
});

describe('InterpolationBuffer', () => {
  it('sin datos no devuelve nada', () => {
    expect(new InterpolationBuffer(100).sample(1000)).toEqual([]);
  });

  it('interpola entre las dos instantaneas que rodean al instante de render', () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push([player(2, 0)], 1000);
    buffer.push([player(2, 200)], 1100);

    // now = 1150 => renderTime = 1050, justo a mitad de camino.
    const sample = buffer.sample(1150);
    expect(sample[0]!.pos.x).toBeCloseTo(100, 6);
  });

  it('dibuja el pasado: nunca extrapola hacia delante', () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push([player(2, 0)], 1000);
    buffer.push([player(2, 200)], 1100);

    // Con now = 1100 el instante de render (1000) es la instantanea antigua.
    expect(buffer.sample(1100)[0]!.pos.x).toBeCloseTo(0, 6);
  });

  it('se queda en la ultima instantanea si el rival deja de actualizarse', () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push([player(2, 0)], 1000);
    buffer.push([player(2, 200)], 1100);

    expect(buffer.sample(5000)[0]!.pos.x).toBe(200);
  });

  it('excluye al jugador local, que va predicho', () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push([player(1, 0), player(2, 50)], 1000);
    buffer.push([player(1, 10), player(2, 60)], 1100);

    const sample = buffer.sample(1150, 1);
    expect(sample).toHaveLength(1);
    expect(sample[0]!.id).toBe(2);
  });

  it('interpola los angulos por el camino corto', () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push([player(2, 0, 170)], 1000);
    buffer.push([player(2, 0, -170)], 1100);

    // De 170 a -170 son 20 grados, no 340.
    expect(Math.abs(buffer.sample(1150)[0]!.yaw)).toBeCloseTo(180, 4);
  });

  it('no mezcla los estados discretos', () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push([player(2, 0, 0, SNAPSHOT_FLAG.ALIVE)], 1000);
    buffer.push(
      [player(2, 200, 0, SNAPSHOT_FLAG.ALIVE | SNAPSHOT_FLAG.DUCKING)],
      1100,
    );

    expect(buffer.sample(1120)[0]!.ducking).toBe(false);
    expect(buffer.sample(1180)[0]!.ducking).toBe(true);
  });

  it('mantiene a un jugador que desaparece de la instantanea nueva', () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push([player(2, 0), player(3, 500)], 1000);
    buffer.push([player(2, 200)], 1100);

    const sample = buffer.sample(1150);
    expect(sample).toHaveLength(2);
    expect(sample.find((p) => p.id === 3)!.pos.x).toBe(500);
  });

  it('descarta las instantaneas mas antiguas para no crecer sin limite', () => {
    const buffer = new InterpolationBuffer(100);
    for (let i = 0; i < 200; i++) buffer.push([player(2, i)], 1000 + i * 16);
    expect(buffer.size).toBeLessThanOrEqual(48);
  });

  it('clear vacia el buffer', () => {
    const buffer = new InterpolationBuffer(100);
    buffer.push([player(2, 0)], 1000);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.sample(2000)).toEqual([]);
  });

  it('traduce los bits de estado a booleanos', () => {
    const buffer = new InterpolationBuffer(0);
    buffer.push([player(2, 0, 0, SNAPSHOT_FLAG.ON_GROUND)], 1000);

    const sample = buffer.sample(1000)[0]!;
    expect(sample.onGround).toBe(true);
    expect(sample.alive).toBe(false);
  });
});
