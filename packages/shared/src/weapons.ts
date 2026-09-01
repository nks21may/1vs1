/**
 * Armas, retroceso y dispersion.
 *
 * Todo el comportamiento es determinista a partir de una semilla: el cliente
 * puede predecir la trayectoria exacta de su propia bala (tracer, decal, sonido)
 * sin esperar al servidor, y el servidor puede recalcularla para validarla.
 *
 * El patron de retroceso es fijo y aprendible, como en CS: la bala se desvia
 * segun `recoilPattern` mientras la vista solo sube una fraccion (`viewPunchRatio`),
 * de modo que controlar el spray es una habilidad y no una compensacion automatica.
 */

import { createRandom, degToRad, hashSeed } from './math.js';

export type WeaponId = 'rifle' | 'pistol';
export type FireMode = 'auto' | 'semi';

export interface SpreadProfile {
  /** Dispersion base disparando quieto y de pie (grados). */
  base: number;
  /** Penalizacion maxima por moverse a velocidad plena. */
  moving: number;
  /** Penalizacion en el aire: saltar y disparar no es viable. */
  air: number;
  /** Multiplicador al ir agachado (< 1 = mas preciso). */
  duckingMultiplier: number;
}

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  readonly mode: FireMode;
  /** Segundos entre disparos. */
  readonly cycleTime: number;
  readonly damage: number;
  readonly headshotMultiplier: number;
  readonly legMultiplier: number;
  readonly magazine: number;
  readonly reloadTime: number;
  /** Multiplicador de velocidad de movimiento al llevarla equipada. */
  readonly speedMultiplier: number;
  readonly spread: SpreadProfile;
  /** Alcance maximo del hitscan en unidades. */
  readonly range: number;
  /** Distancia a partir de la cual el dano decae. */
  readonly falloffStart: number;
  /** Fraccion de dano perdida por cada 1000 unidades pasado `falloffStart`. */
  readonly falloffPer1000: number;
  /** Patron de retroceso: desplazamientos acumulados [yaw, pitch] en grados. */
  readonly recoilPattern: readonly (readonly [number, number])[];
  /** Segundos sin disparar tras los que el patron se reinicia. */
  readonly recoilResetTime: number;
  /** Fraccion del retroceso que se traslada a la camara. */
  readonly viewPunchRatio: number;
  /** Velocidad de recuperacion de la camara (fraccion por segundo). */
  readonly viewPunchRecovery: number;
  /** Color del trazador, en hexadecimal, para el cliente. */
  readonly tracerColor: number;
}

/**
 * Genera un patron de spray al estilo AK: subida vertical fuerte al principio,
 * luego una "T" hacia la izquierda y una vuelta a la derecha.
 * Es determinista (semilla fija), asi que el patron es siempre el mismo y se
 * puede memorizar.
 */
const buildRiflePattern = (shots: number): (readonly [number, number])[] => {
  const random = createRandom(0x5eed1a3);
  const pattern: (readonly [number, number])[] = [];
  let yaw = 0;
  let pitch = 0;

  for (let i = 0; i < shots; i++) {
    // El desplazamiento se anota *antes* de acumular el de esta bala: la
    // primera va exactamente donde apunta la mira (first bullet accuracy).
    pattern.push([
      Math.round(yaw * 1000) / 1000,
      Math.round(pitch * 1000) / 1000,
    ] as const);

    // Subida vertical: agresiva en las 4 primeras balas, luego se aplana.
    const climb = i < 4 ? 1.15 - i * 0.12 : 0.42 + 0.2 * Math.exp(-(i - 4) / 6);
    pitch += climb;

    // Deriva horizontal por fases: recta, izquierda, derecha.
    let drift: number;
    if (i < 4) drift = (random() - 0.5) * 0.12;
    else if (i < 11) drift = -0.55 - (random() - 0.5) * 0.18;
    else if (i < 20) drift = 0.62 + (random() - 0.5) * 0.22;
    else drift = -0.3 + (random() - 0.5) * 0.5;
    yaw += drift;
  }
  return pattern;
};

const buildPistolPattern = (shots: number): (readonly [number, number])[] => {
  const random = createRandom(0xb0a7);
  const pattern: (readonly [number, number])[] = [];
  let yaw = 0;
  let pitch = 0;
  for (let i = 0; i < shots; i++) {
    pattern.push([
      Math.round(yaw * 1000) / 1000,
      Math.round(pitch * 1000) / 1000,
    ] as const);
    pitch += 0.75 + i * 0.05;
    yaw += (random() - 0.5) * 0.7;
  }
  return pattern;
};

export const RIFLE: WeaponDef = {
  id: 'rifle',
  name: 'VEKTOR-9',
  mode: 'auto',
  cycleTime: 0.1,
  damage: 33,
  headshotMultiplier: 4,
  legMultiplier: 0.75,
  magazine: 30,
  reloadTime: 2.4,
  speedMultiplier: 0.86,
  spread: { base: 0.12, moving: 3.6, air: 9, duckingMultiplier: 0.65 },
  range: 8192,
  falloffStart: 1200,
  falloffPer1000: 0.18,
  recoilPattern: buildRiflePattern(30),
  recoilResetTime: 0.35,
  viewPunchRatio: 0.35,
  viewPunchRecovery: 9,
  tracerColor: 0x6ff7ff,
};

export const PISTOL: WeaponDef = {
  id: 'pistol',
  name: 'AXIOM',
  mode: 'semi',
  cycleTime: 0.15,
  damage: 26,
  headshotMultiplier: 4,
  legMultiplier: 0.75,
  magazine: 20,
  reloadTime: 1.8,
  speedMultiplier: 1,
  spread: { base: 0.2, moving: 2.4, air: 6, duckingMultiplier: 0.7 },
  range: 4096,
  falloffStart: 800,
  falloffPer1000: 0.3,
  recoilPattern: buildPistolPattern(20),
  recoilResetTime: 0.45,
  viewPunchRatio: 0.4,
  viewPunchRecovery: 11,
  tracerColor: 0xff8ad8,
};

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = {
  rifle: RIFLE,
  pistol: PISTOL,
};

export const getWeapon = (id: WeaponId): WeaponDef => WEAPONS[id];

/** Contexto de precision en el instante del disparo. */
export interface AccuracyContext {
  /** Velocidad horizontal del jugador (unidades/s). */
  speed: number;
  onGround: boolean;
  ducking: boolean;
}

/**
 * Dispersion efectiva en grados. Moverse penaliza de forma cuadratica: andar
 * despacio apenas afecta, correr hace el arma inutilizable a media distancia.
 */
export const computeSpread = (
  weapon: WeaponDef,
  ctx: AccuracyContext,
  maxSpeed: number,
): number => {
  const speedRatio = maxSpeed > 0 ? Math.min(1, ctx.speed / maxSpeed) : 0;
  let spread = weapon.spread.base + weapon.spread.moving * speedRatio ** 2;
  if (!ctx.onGround) spread += weapon.spread.air;
  if (ctx.ducking) spread *= weapon.spread.duckingMultiplier;
  return spread;
};

/** Desplazamiento acumulado del patron para la bala `shotIndex` (0-based). */
export const getRecoil = (
  weapon: WeaponDef,
  shotIndex: number,
): { yaw: number; pitch: number } => {
  const pattern = weapon.recoilPattern;
  if (pattern.length === 0) return { yaw: 0, pitch: 0 };
  const entry = pattern[Math.min(shotIndex, pattern.length - 1)]!;
  return { yaw: entry[0], pitch: entry[1] };
};

export interface ShotAngles {
  yaw: number;
  pitch: number;
}

/**
 * Angulos finales de una bala: vista + retroceso del patron + dispersion
 * aleatoria determinista. `seed` debe construirse con datos que cliente y
 * servidor comparten (id de jugador, tick y numero de disparo).
 */
export const computeShotAngles = (
  weapon: WeaponDef,
  view: ShotAngles,
  shotIndex: number,
  spreadDegrees: number,
  seed: number,
): ShotAngles => {
  const recoil = getRecoil(weapon, shotIndex);
  const random = createRandom(seed);

  // Muestreo uniforme en el disco de dispersion.
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(random()) * spreadDegrees;
  const spreadYaw = Math.cos(angle) * radius;
  const spreadPitch = Math.sin(angle) * radius;

  return {
    // El retroceso sube la mira: en nuestra convencion pitch positivo mira
    // hacia abajo, por eso se resta.
    yaw: view.yaw + recoil.yaw + spreadYaw,
    pitch: view.pitch - recoil.pitch + spreadPitch,
  };
};

/**
 * Semilla estable de un disparo concreto. Se usa el contador total de disparos
 * del jugador (no el reloj) porque es un valor que el cliente reproduce igual
 * al repredecir sus comandos.
 */
export const shotSeed = (playerId: number, shotCounter: number): number =>
  hashSeed(playerId, shotCounter, 0x9e37);

export type HitGroup = 'head' | 'chest' | 'legs';

/** Dano final segun zona alcanzada y distancia recorrida. */
export const computeDamage = (
  weapon: WeaponDef,
  hitGroup: HitGroup,
  distance: number,
): number => {
  let damage = weapon.damage;
  if (hitGroup === 'head') damage *= weapon.headshotMultiplier;
  else if (hitGroup === 'legs') damage *= weapon.legMultiplier;

  if (distance > weapon.falloffStart) {
    const extra = (distance - weapon.falloffStart) / 1000;
    damage *= Math.max(0.35, 1 - extra * weapon.falloffPer1000);
  }
  return Math.max(1, Math.round(damage));
};

/** Conversion de grados a radianes reexportada por comodidad del cliente. */
export const spreadToRadians = (degrees: number): number => degToRad(degrees);
