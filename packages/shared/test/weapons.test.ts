import { describe, expect, it } from 'vitest';

import { MAX_HEALTH, MAX_SPEED } from '../src/constants.js';
import {
  KNIFE,
  PISTOL,
  RIFLE,
  SNIPER,
  WEAPONS,
  WEAPON_SLOTS,
  computeDamage,
  computeShotAngles,
  computeSpread,
  getRecoil,
  shotSeed,
  weaponForSlot,
  weaponSpeedMultiplier,
} from '../src/weapons.js';

describe('ranuras de arma', () => {
  it('hay una ranura por arma y ninguna se repite', () => {
    expect(new Set(WEAPON_SLOTS).size).toBe(WEAPON_SLOTS.length);
    expect(WEAPON_SLOTS.length).toBe(Object.keys(WEAPONS).length);
  });

  it('el orden es el que se le cuenta al jugador', () => {
    expect(weaponForSlot(1)).toBe('rifle');
    expect(weaponForSlot(2)).toBe('pistol');
    expect(weaponForSlot(3)).toBe('knife');
    expect(weaponForSlot(4)).toBe('sniper');
  });

  it('fuera de rango no hay arma', () => {
    expect(weaponForSlot(0)).toBeNull();
    expect(weaponForSlot(5)).toBeNull();
    expect(weaponForSlot(-1)).toBeNull();
  });
});

describe('cuchillo', () => {
  it('es la unica arma cuerpo a cuerpo', () => {
    const cuerpoACuerpo = Object.values(WEAPONS).filter((w) => w.melee);
    expect(cuerpoACuerpo).toEqual([KNIFE]);
  });

  it('sin cargador que gastar ni recarga que esperar', () => {
    expect(KNIFE.magazine).toBe(0);
    expect(KNIFE.reloadTime).toBe(0);
  });

  it('acierta igual quieto que corriendo: a esa distancia no hay cono', () => {
    const parado = computeSpread(KNIFE, { speed: 0, onGround: true, ducking: false }, MAX_SPEED);
    const corriendo = computeSpread(
      KNIFE,
      { speed: MAX_SPEED, onGround: true, ducking: false },
      MAX_SPEED,
    );
    expect(parado).toBe(0);
    expect(corriendo).toBe(0);
  });

  it('dos tajos al cuerpo matan, uno a la cabeza tambien', () => {
    expect(computeDamage(KNIFE, 'chest', 40) * 2).toBeGreaterThanOrEqual(MAX_HEALTH);
    expect(computeDamage(KNIFE, 'chest', 40)).toBeLessThan(MAX_HEALTH);
    expect(computeDamage(KNIFE, 'head', 40)).toBeGreaterThanOrEqual(MAX_HEALTH);
  });
});

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
    const spread = computeSpread(RIFLE, { speed: 0, onGround: true, ducking: false }, maxSpeed);
    expect(spread).toBeCloseTo(RIFLE.spread.base, 6);
  });

  it('correr penaliza mucho mas que andar despacio', () => {
    const slow = computeSpread(RIFLE, { speed: 60, onGround: true, ducking: false }, maxSpeed);
    const fast = computeSpread(RIFLE, { speed: 250, onGround: true, ducking: false }, maxSpeed);
    expect(fast).toBeGreaterThan(slow * 5);
  });

  it('saltar hace el arma poco fiable', () => {
    const air = computeSpread(RIFLE, { speed: 0, onGround: false, ducking: false }, maxSpeed);
    expect(air).toBeGreaterThan(RIFLE.spread.air);
  });

  it('agacharse mejora la precision', () => {
    const standing = computeSpread(RIFLE, { speed: 0, onGround: true, ducking: false }, maxSpeed);
    const ducked = computeSpread(RIFLE, { speed: 0, onGround: true, ducking: true }, maxSpeed);
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
      const angles = computeShotAngles(RIFLE, { yaw: 0, pitch: 0 }, 0, spread, shotSeed(1, i));
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
    expect(computeDamage(RIFLE, 'legs', 100)).toBeLessThan(computeDamage(RIFLE, 'chest', 100));
  });

  it('el dano decae con la distancia pero nunca a cero', () => {
    const near = computeDamage(RIFLE, 'chest', 100);
    const far = computeDamage(RIFLE, 'chest', 6000);
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThan(0);
  });

  it('la pistola pierde eficacia mas rapido que el rifle', () => {
    const rifleRatio = computeDamage(RIFLE, 'chest', 3000) / computeDamage(RIFLE, 'chest', 0);
    const pistolRatio = computeDamage(PISTOL, 'chest', 3000) / computeDamage(PISTOL, 'chest', 0);
    expect(pistolRatio).toBeLessThan(rifleRatio);
  });
});

describe('rifle de precision', () => {
  const quieto = { speed: 0, onGround: true, ducking: false };
  const corriendo = { speed: MAX_SPEED, onGround: true, ducking: false };

  it('mata de un tiro al cuerpo a un jugador a plena vida', () => {
    expect(computeDamage(SNIPER, 'chest', 0)).toBeGreaterThanOrEqual(MAX_HEALTH);
  });

  it('a las piernas no mata de una vez: hay que acertar arriba', () => {
    expect(computeDamage(SNIPER, 'legs', 0)).toBeLessThan(MAX_HEALTH);
  });

  it('aguanta el dano a distancia, que es para lo que esta', () => {
    const cerca = computeDamage(SNIPER, 'chest', 0);
    const lejos = computeDamage(SNIPER, 'chest', 4000);
    expect(lejos).toBe(cerca);
    // Incluso pasado el inicio de la caida sigue matando de un tiro.
    expect(computeDamage(SNIPER, 'chest', 8000)).toBeGreaterThanOrEqual(MAX_HEALTH);
  });

  it('sin apuntar es inservible: dispersa mas que el rifle normal', () => {
    const sniper = computeSpread(SNIPER, quieto, MAX_SPEED);
    const rifle = computeSpread(RIFLE, quieto, MAX_SPEED);
    expect(sniper).toBeGreaterThan(rifle * 5);
  });

  it('apuntando y quieto va donde se apunta', () => {
    const apuntando = computeSpread(SNIPER, { ...quieto, aiming: true }, MAX_SPEED);
    expect(apuntando).toBeLessThan(0.05);
    // Y mejora en mas de un orden de magnitud respecto a la cadera.
    expect(apuntando).toBeLessThan(computeSpread(SNIPER, quieto, MAX_SPEED) / 10);
  });

  it('apuntar no salva el disparo en carrera', () => {
    const quietoApuntando = computeSpread(SNIPER, { ...quieto, aiming: true }, MAX_SPEED);
    const corriendoApuntando = computeSpread(SNIPER, { ...corriendo, aiming: true }, MAX_SPEED);
    expect(corriendoApuntando).toBeGreaterThan(quietoApuntando * 5);
  });

  it('apuntar no hace nada con un arma sin mira', () => {
    expect(computeSpread(RIFLE, { ...quieto, aiming: true }, MAX_SPEED)).toBe(
      computeSpread(RIFLE, quieto, MAX_SPEED),
    );
    expect(weaponSpeedMultiplier(PISTOL, true)).toBe(PISTOL.speedMultiplier);
  });

  it('apuntar cuesta movilidad', () => {
    expect(weaponSpeedMultiplier(SNIPER, true)).toBeLessThan(weaponSpeedMultiplier(SNIPER, false));
    // Y llevarla ya pesa mas que llevar el rifle.
    expect(SNIPER.speedMultiplier).toBeLessThan(RIFLE.speedMultiplier);
  });

  it('el primer tiro sale exacto, como en el resto de armas', () => {
    expect(getRecoil(SNIPER, 0)).toEqual({ yaw: 0, pitch: 0 });
    expect(getRecoil(SNIPER, 1).pitch).toBeGreaterThan(0);
  });

  it('es de un tiro por pulsacion y con ciclo lento', () => {
    expect(SNIPER.mode).toBe('semi');
    expect(SNIPER.cycleTime).toBeGreaterThan(RIFLE.cycleTime * 5);
  });
});
