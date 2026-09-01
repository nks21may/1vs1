import { describe, expect, it } from 'vitest';

import {
  MAX_HEALTH,
} from '../src/constants.js';
import {
  PISTOL,
  RIFLE,
  computeDamage,
  computeShotAngles,
  computeSpread,
  getRecoil,
  shotSeed,
} from '../src/weapons.js';

describe('patron de retroceso', () => {
  it('es acumulativo hacia arriba', () => {
    const first = getRecoil(RIFLE, 0);
    const fifth = getRecoil(RIFLE, 4);
    expect(fifth.pitch).toBeGreaterThan(first.pitch);
  });

  it('se satura en la ultima bala del cargador', () => {
    const last = getRecoil(RIFLE, RIFLE.recoilPattern.length - 1);
    const beyond = getRecoil(RIFLE, 999);
    expect(beyond).toEqual(last);
  });

  it('tiene una fase con deriva a la izquierda y otra a la derecha', () => {
    const midLeft = getRecoil(RIFLE, 9).yaw;
    const midRight = getRecoil(RIFLE, 18).yaw;
    expect(midLeft).toBeLessThan(0);
    expect(midRight).toBeGreaterThan(midLeft);
  });

  it('la primera bala no tiene retroceso: va donde apunta la mira', () => {
    expect(getRecoil(RIFLE, 0)).toEqual({ yaw: 0, pitch: 0 });
    expect(getRecoil(PISTOL, 0)).toEqual({ yaw: 0, pitch: 0 });
    expect(getRecoil(RIFLE, 1).pitch).toBeGreaterThan(0);
  });

  it('el patron es identico entre ejecuciones (memorizable)', () => {
    const snapshot = RIFLE.recoilPattern.map(([yaw, pitch]) => `${yaw}:${pitch}`);
    expect(snapshot[1]).toBe('0.018:1.15');
    expect(snapshot.length).toBe(30);
  });
});

describe('computeSpread', () => {
  const maxSpeed = 250;

  it('quieto y de pie es casi perfecto', () => {
    const spread = computeSpread(
      RIFLE,
      { speed: 0, onGround: true, ducking: false },
      maxSpeed,
    );
    expect(spread).toBeCloseTo(RIFLE.spread.base, 6);
  });

  it('correr penaliza mucho mas que andar despacio', () => {
    const slow = computeSpread(
      RIFLE,
      { speed: 60, onGround: true, ducking: false },
      maxSpeed,
    );
    const fast = computeSpread(
      RIFLE,
      { speed: 250, onGround: true, ducking: false },
      maxSpeed,
    );
    expect(fast).toBeGreaterThan(slow * 5);
  });

  it('saltar hace el arma poco fiable', () => {
    const air = computeSpread(
      RIFLE,
      { speed: 0, onGround: false, ducking: false },
      maxSpeed,
    );
    expect(air).toBeGreaterThan(RIFLE.spread.air);
  });

  it('agacharse mejora la precision', () => {
    const standing = computeSpread(
      RIFLE,
      { speed: 0, onGround: true, ducking: false },
      maxSpeed,
    );
    const ducked = computeSpread(
      RIFLE,
      { speed: 0, onGround: true, ducking: true },
      maxSpeed,
    );
    expect(ducked).toBeLessThan(standing);
  });
});

describe('computeShotAngles', () => {
  it('sin dispersion la bala sigue exactamente el patron', () => {
    const angles = computeShotAngles(RIFLE, { yaw: 0, pitch: 0 }, 3, 0, 1);
    const recoil = getRecoil(RIFLE, 3);
    expect(angles.yaw).toBeCloseTo(recoil.yaw, 9);
    expect(angles.pitch).toBeCloseTo(-recoil.pitch, 9);
  });

  it('la misma semilla produce siempre la misma bala', () => {
    const seed = shotSeed(7, 42);
    const a = computeShotAngles(RIFLE, { yaw: 10, pitch: -5 }, 0, 2, seed);
    const b = computeShotAngles(RIFLE, { yaw: 10, pitch: -5 }, 0, 2, seed);
    expect(a).toEqual(b);
  });

  it('la dispersion nunca excede el radio indicado', () => {
    const spread = 3;
    for (let i = 0; i < 500; i++) {
      const angles = computeShotAngles(
        RIFLE,
        { yaw: 0, pitch: 0 },
        0,
        spread,
        shotSeed(1, i),
      );
      const recoil = getRecoil(RIFLE, 0);
      const dx = angles.yaw - recoil.yaw;
      const dy = angles.pitch + recoil.pitch;
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(spread + 1e-9);
    }
  });
});

describe('computeDamage', () => {
  it('el rifle mata de un tiro a la cabeza a quemarropa', () => {
    expect(computeDamage(RIFLE, 'head', 100)).toBeGreaterThanOrEqual(MAX_HEALTH);
  });

  it('la pistola tambien mata de un headshot cercano', () => {
    expect(computeDamage(PISTOL, 'head', 100)).toBeGreaterThanOrEqual(MAX_HEALTH);
  });

  it('el rifle necesita cuatro balas al cuerpo', () => {
    const perShot = computeDamage(RIFLE, 'chest', 100);
    expect(perShot * 3).toBeLessThan(MAX_HEALTH);
    expect(perShot * 4).toBeGreaterThanOrEqual(MAX_HEALTH);
  });

  it('las piernas hacen menos dano que el torso', () => {
    expect(computeDamage(RIFLE, 'legs', 100)).toBeLessThan(
      computeDamage(RIFLE, 'chest', 100),
    );
  });

  it('el dano decae con la distancia pero nunca a cero', () => {
    const near = computeDamage(RIFLE, 'chest', 100);
    const far = computeDamage(RIFLE, 'chest', 6000);
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThan(0);
  });

  it('la pistola pierde eficacia mas rapido que el rifle', () => {
    const rifleRatio = computeDamage(RIFLE, 'chest', 3000) / computeDamage(RIFLE, 'chest', 0);
    const pistolRatio =
      computeDamage(PISTOL, 'chest', 3000) / computeDamage(PISTOL, 'chest', 0);
    expect(pistolRatio).toBeLessThan(rifleRatio);
  });
});
