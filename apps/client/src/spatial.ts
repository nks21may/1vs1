/**
 * Conversion entre las coordenadas de la simulacion y las del audio.
 *
 * La simulacion es Z-arriba (X adelante, Y a la izquierda, Z arriba, como
 * Source). Tanto three.js como la Web Audio API son Y-arriba con -Z hacia
 * delante. La traduccion es un giro de -90 grados sobre X, que es un giro
 * propio: no invierte la mano, asi que los productos vectoriales (y con ellos
 * la izquierda y la derecha del jugador) se conservan. Esa es justo la parte
 * que hay que acertar para que un disparo por la izquierda suene a la
 * izquierda y no al reves.
 */

import { type Vec3, angleVectors, vec3 } from '@neonduel/shared';

/** Pasa un punto o una direccion de la simulacion al espacio del audio. */
export const toAudioCoords = (v: Vec3): Vec3 => vec3(v.x, v.z, -v.y);

/**
 * Vectores de orientacion del oyente a partir de los angulos de vista, ya en
 * coordenadas de audio y listos para `AudioListener`.
 */
export const listenerVectors = (
  yawDeg: number,
  pitchDeg: number,
): { forward: Vec3; up: Vec3 } => {
  const { forward, up } = angleVectors(yawDeg, pitchDeg);
  return { forward: toAudioCoords(forward), up: toAudioCoords(up) };
};
