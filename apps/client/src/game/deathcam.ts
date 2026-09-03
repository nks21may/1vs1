/**
 * Camara de muerte.
 *
 * Al morir, la vista deja de estar congelada donde estaba y gira hacia quien te
 * mato, siguiendolo hasta el final de la ronda. Ademas de quitar el corte seco,
 * informa: enterarte de por donde vino el disparo es la mitad de aprender el
 * mapa. Si no hubo asesino (una caida), se queda mirando el punto donde caiste.
 */

import { type Vec3, clamp, lerp, lerpAngle, radToDeg, vec3 } from '@neonduel/shared';

/**
 * Rapidez del giro, en "unidades de e por segundo". El suavizado es
 * exponencial y no lineal para que no dependa de los fotogramas por segundo:
 * con 30 o con 240 el giro tarda lo mismo.
 */
const TURN_RATE = 3.4;

/** Cuanto se levanta la camara sobre el cuerpo, para no quedar dentro de el. */
const RISE = 28;

/**
 * A que altura del asesino se mira. Su posicion es la de los pies: apuntar ahi
 * dejaria la camara mirando al suelo cuando esta cerca.
 */
const CHEST = 44;

export interface DeathCamera {
  /** A quien seguir, o `null` si no hubo asesino. */
  killerId: number | null;
  /** Desde donde se mira: donde estaba la vista al morir, un poco mas arriba. */
  readonly eye: Vec3;
  /** Donde cayo el cuerpo, que es a lo que se mira si no hubo asesino. */
  readonly impact: Vec3;
  yaw: number;
  pitch: number;
}

/**
 * Angulos para mirar de un punto a otro, en la convencion de la simulacion:
 * yaw 0 mira a +X y el pitch positivo mira hacia abajo.
 */
export const lookAngles = (from: Vec3, to: Vec3): { yaw: number; pitch: number } => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const flat = Math.hypot(dx, dy);
  // Mirando en vertical el yaw no esta definido; se deja el que hubiera.
  const yaw = flat < 1e-6 && Math.abs(dz) > 0 ? Number.NaN : radToDeg(Math.atan2(dy, dx));
  return { yaw, pitch: radToDeg(Math.atan2(-dz, flat)) };
};

export const createDeathCamera = (
  eye: Vec3,
  yaw: number,
  pitch: number,
  killerId: number | null,
): DeathCamera => ({
  killerId,
  eye: vec3(eye.x, eye.y, eye.z + RISE),
  impact: vec3(eye.x, eye.y, eye.z),
  yaw,
  pitch,
});

/**
 * Acerca la vista a su objetivo. `killer` es donde esta ahora el asesino, o
 * `null` si no se sabe o no lo hubo: entonces se mira al punto de impacto.
 */
export const updateDeathCamera = (cam: DeathCamera, killer: Vec3 | null, dt: number): void => {
  const target = killer ? vec3(killer.x, killer.y, killer.z + CHEST) : cam.impact;
  const { yaw, pitch } = lookAngles(cam.eye, target);

  // Con dt muy grande (una pestana en segundo plano) el factor se acerca a 1 y
  // el giro se completa de golpe, que es preferible a pasarse de largo.
  const t = 1 - Math.exp(-TURN_RATE * clamp(dt, 0, 1));
  if (!Number.isNaN(yaw)) cam.yaw = lerpAngle(cam.yaw, yaw, t);
  cam.pitch = lerp(cam.pitch, pitch, t);
};
