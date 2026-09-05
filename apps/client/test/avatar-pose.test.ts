/**
 * La pose del avatar es lo unico del render que se puede comprobar sin WebGL:
 * son numeros derivados de la velocidad. Lo que se fija aqui es que el avatar
 * cuente la verdad sobre lo que esta haciendo su jugador.
 */

import { describe, expect, it } from 'vitest';

import { MAX_SPEED, vec3 } from '@neonduel/shared';

import { avatarPose } from '../src/render/avatar-pose.js';

const quieto = vec3();
const DT = 1 / 64;

describe('pose del avatar', () => {
  it('parado y en el suelo no se inclina ni mueve las piernas', () => {
    const pose = avatarPose(0, quieto, 0, true, DT);
    expect(pose.lean).toBeCloseTo(0, 9);
    expect(pose.roll).toBeCloseTo(0, 9);
    expect(pose.legs[0]).toBeCloseTo(0, 9);
    expect(pose.legs[1]).toBeCloseTo(0, 9);
  });

  it('correr de frente inclina hacia delante', () => {
    const pose = avatarPose(0, vec3(MAX_SPEED, 0, 0), 0, true, DT);
    expect(pose.lean).toBeGreaterThan(0.1);
    expect(Math.abs(pose.roll)).toBeLessThan(0.001);
  });

  it('ir hacia atras inclina hacia atras', () => {
    const pose = avatarPose(0, vec3(-MAX_SPEED, 0, 0), 0, true, DT);
    expect(pose.lean).toBeLessThan(-0.1);
  });

  it('el alabeo sigue al lado hacia el que se desplaza', () => {
    // Mirando a +X, la derecha del jugador es -Y.
    const derecha = avatarPose(0, vec3(0, -MAX_SPEED, 0), 0, true, DT);
    const izquierda = avatarPose(0, vec3(0, MAX_SPEED, 0), 0, true, DT);
    expect(derecha.roll).toBeGreaterThan(0.1);
    expect(izquierda.roll).toBeLessThan(-0.1);
    expect(Math.abs(derecha.lean)).toBeLessThan(0.001);
  });

  it('la inclinacion es la misma se mire hacia donde se mire', () => {
    // Correr de frente es correr de frente: girar el mapa no cambia la pose.
    for (const yaw of [0, 37, 90, -145, 200]) {
      const rad = (yaw * Math.PI) / 180;
      const vel = vec3(Math.cos(rad) * MAX_SPEED, Math.sin(rad) * MAX_SPEED, 0);
      const pose = avatarPose(0, vel, yaw, true, DT);
      expect(pose.lean).toBeCloseTo(0.2, 6);
      expect(pose.roll).toBeCloseTo(0, 6);
    }
  });

  it('las piernas van siempre opuestas en el suelo', () => {
    let phase = 0;
    for (let i = 0; i < 200; i++) {
      const pose = avatarPose(phase, vec3(MAX_SPEED, 0, 0), 0, true, DT);
      expect(pose.legs[0]).toBeCloseTo(-pose.legs[1], 9);
      phase = pose.phase;
    }
  });

  it('el ciclo avanza con la distancia y no con el tiempo', () => {
    // La misma distancia en un paso grande o en muchos pequenos tiene que
    // dejar la zancada en el mismo sitio: si dependiera del tiempo, ir despacio
    // haria patinar los pies.
    const deUnaVez = avatarPose(0, vec3(120, 0, 0), 0, true, 0.5).phase;

    let phase = 0;
    for (let i = 0; i < 32; i++) {
      phase = avatarPose(phase, vec3(120, 0, 0), 0, true, 0.5 / 32).phase;
    }
    expect(phase).toBeCloseTo(deUnaVez, 6);
  });

  it('a mas velocidad, mas zancada', () => {
    const cuarto = Math.PI / 2; // fase de maxima apertura
    const lento = avatarPose(cuarto, vec3(60, 0, 0), 0, true, 0);
    const rapido = avatarPose(cuarto, vec3(MAX_SPEED, 0, 0), 0, true, 0);
    expect(Math.abs(rapido.legs[0])).toBeGreaterThan(Math.abs(lento.legs[0]));
  });

  it('en el aire recoge las piernas y congela el ciclo', () => {
    const pose = avatarPose(1.23, vec3(MAX_SPEED, 0, 0), 0, false, DT);
    expect(pose.phase).toBe(1.23);
    expect(pose.legs[0]).toBeLessThan(0);
    expect(pose.legs[1]).toBeGreaterThan(0);
  });

  it('al aterrizar la zancada sigue donde estaba', () => {
    const enElAire = avatarPose(2, vec3(MAX_SPEED, 0, 0), 0, false, DT);
    const alTocar = avatarPose(enElAire.phase, vec3(MAX_SPEED, 0, 0), 0, true, DT);
    expect(alTocar.phase).toBeGreaterThan(2);
    expect(alTocar.phase).toBeLessThan(2.2);
  });
});
