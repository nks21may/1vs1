/**
 * Utilidades de algebra vectorial para la simulacion.
 *
 * Los vectores son objetos planos `{x, y, z}` para que sean serializables sin
 * conversiones y comparables en los tests. El sistema de coordenadas es Z-up
 * (como Source/GoldSrc): X = este, Y = norte, Z = arriba.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const clone = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const copy = (out: Vec3, v: Vec3): Vec3 => set(out, v.x, v.y, v.z);

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);

export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);

export const scale = (v: Vec3, s: number): Vec3 => vec3(v.x * s, v.y * s, v.z * s);

/** `out = out + v * s`, sin asignar memoria (hot path del movimiento). */
export const addScaled = (out: Vec3, v: Vec3, s: number): Vec3 =>
  set(out, out.x + v.x * s, out.y + v.y * s, out.z + v.z * s);

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lengthSq = (v: Vec3): number => v.x * v.x + v.y * v.y + v.z * v.z;

export const length = (v: Vec3): number => Math.sqrt(lengthSq(v));

/** Magnitud en el plano horizontal: la velocidad que limitan `maxSpeed` y la friccion. */
export const length2D = (v: Vec3): number => Math.hypot(v.x, v.y);

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/** Normaliza en sitio y devuelve la longitud previa (0 si el vector era nulo). */
export const normalizeInPlace = (v: Vec3): number => {
  const len = length(v);
  if (len < 1e-9) {
    set(v, 0, 0, 0);
    return 0;
  }
  const inv = 1 / len;
  v.x *= inv;
  v.y *= inv;
  v.z *= inv;
  return len;
};

export const normalize = (v: Vec3): Vec3 => {
  const out = clone(v);
  normalizeInPlace(out);
  return out;
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;

export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Envuelve un angulo en grados al rango [-180, 180). */
export const normalizeAngle = (deg: number): number => {
  let a = ((deg + 180) % 360 + 360) % 360;
  a -= 180;
  return a === 180 ? -180 : a;
};

/** Diferencia angular mas corta entre dos angulos en grados. */
export const angleDelta = (from: number, to: number): number => normalizeAngle(to - from);

/** Interpola angularmente tomando siempre el camino corto. */
export const lerpAngle = (from: number, to: number, t: number): number =>
  normalizeAngle(from + angleDelta(from, to) * t);

/**
 * Vectores base a partir de los angulos de vista (grados).
 * `yaw` gira sobre Z (0 = +X, 90 = +Y) y `pitch` es positivo hacia abajo,
 * igual que en los motores de Valve.
 */
export interface AngleVectors {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export const angleVectors = (yawDeg: number, pitchDeg: number): AngleVectors => {
  const yaw = degToRad(yawDeg);
  const pitch = degToRad(pitchDeg);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);

  const forward = vec3(cp * cy, cp * sy, -sp);
  // `right` es la mano derecha del jugador: yaw - 90 grados, sin componente vertical.
  const right = vec3(sy, -cy, 0);
  const up = cross(right, forward);
  return { forward, right, up };
};

/** Direccion horizontal (plano XY) de una mirada, ya normalizada. */
export const forward2D = (yawDeg: number): Vec3 => {
  const yaw = degToRad(yawDeg);
  return vec3(Math.cos(yaw), Math.sin(yaw), 0);
};

/**
 * Generador congruente determinista (mulberry32).
 * Cliente y servidor lo siembran con la misma semilla para reproducir la
 * dispersion de cada disparo sin necesidad de sincronizar numeros aleatorios.
 */
export const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Mezcla varios enteros en una semilla estable de 32 bits. */
export const hashSeed = (...parts: number[]): number => {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    h ^= part >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};
