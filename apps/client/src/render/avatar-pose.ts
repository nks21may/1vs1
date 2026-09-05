/**
 * Postura del avatar a partir de su movimiento.
 *
 * No hay esqueleto ni animaciones: la pose sale de la velocidad interpolada,
 * que es informacion que el cliente ya tiene. Se calcula aparte del render
 * porque es lo unico que se puede comprobar sin WebGL, y porque asi la parte
 * que decide "que hace ese jugador" no esta mezclada con la que mueve cajas.
 */

import { type Vec3, MAX_SPEED, clamp, degToRad } from '@neonduel/shared';

/** Inclinacion maxima hacia delante a velocidad plena (radianes). */
const MAX_LEAN = 0.2;

/** Alabeo maximo al desplazarse de lado (radianes). */
const MAX_ROLL = 0.14;

/** Apertura maxima de la zancada (radianes). */
const MAX_SWING = 0.72;

/**
 * Distancia de un ciclo completo de paso. Es el doble de la zancada que usan
 * los pasos audibles, porque un ciclo son dos pisadas: asi lo que se ve y lo
 * que se oye van al mismo ritmo en vez de cada uno por su lado.
 */
const CYCLE_DISTANCE = 168;

/** Pose en el aire: pierna adelantada recogida y la otra colgando atras. */
const AIR_FRONT = -0.5;
const AIR_BACK = 0.28;

export interface AvatarPose {
  /** Inclinacion hacia delante; negativa al frenar o ir hacia atras. */
  lean: number;
  /** Alabeo hacia la derecha del propio avatar. */
  roll: number;
  /** Angulo de cada pierna. En el suelo son opuestas; en el aire, recogidas. */
  legs: readonly [number, number];
  /** Fase del ciclo de paso, en radianes. */
  phase: number;
}

/**
 * Calcula la pose y avanza el ciclo de paso.
 *
 * La fase avanza con la **distancia recorrida** y no con el tiempo: asi los
 * pies no patinan cuando el jugador va lento, que es justo lo que delata a una
 * animacion cosida a un temporizador.
 */
export const avatarPose = (
  phase: number,
  vel: Vec3,
  yawDeg: number,
  onGround: boolean,
  dt: number,
): AvatarPose => {
  const yaw = degToRad(yawDeg);
  // Ejes del propio avatar, con la convencion de la simulacion: yaw 0 mira a
  // +X y su derecha es -Y.
  const adelante = vel.x * Math.cos(yaw) + vel.y * Math.sin(yaw);
  const lado = vel.x * Math.sin(yaw) - vel.y * Math.cos(yaw);
  const speed = Math.hypot(vel.x, vel.y);

  const lean = clamp(adelante / MAX_SPEED, -1, 1) * MAX_LEAN;
  const roll = clamp(lado / MAX_SPEED, -1, 1) * MAX_ROLL;

  if (!onGround) {
    // En el aire no hay paso que dar. La fase se conserva para que al aterrizar
    // la zancada siga donde estaba y no pegue un salto.
    return { lean, roll, legs: [AIR_FRONT, AIR_BACK], phase };
  }

  const siguiente = phase + (speed * dt * 2 * Math.PI) / CYCLE_DISTANCE;
  const amplitud = Math.min(1, speed / MAX_SPEED) * MAX_SWING;
  const swing = Math.sin(siguiente) * amplitud;
  return { lean, roll, legs: [swing, -swing], phase: siguiente % (2 * Math.PI) };
};
