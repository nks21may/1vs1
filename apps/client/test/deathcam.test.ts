/**
 * La camara de muerte gira sola, asi que lo que se comprueba aqui es que
 * termina mirando a donde debe y que tarda lo mismo pase lo que pase con los
 * fotogramas por segundo.
 */

import { describe, expect, it } from 'vitest';

import { angleDelta, vec3 } from '@neonduel/shared';

import { createDeathCamera, lookAngles, updateDeathCamera } from '../src/game/deathcam.js';

/** Deja correr la camara `seconds` segundos a `fps` cuadros por segundo. */
const settle = (
  cam: ReturnType<typeof createDeathCamera>,
  killer: { x: number; y: number; z: number } | null,
  seconds: number,
  fps: number,
) => {
  const dt = 1 / fps;
  for (let i = 0; i < Math.round(seconds * fps); i++) updateDeathCamera(cam, killer, dt);
};

describe('angulos para mirar a un punto', () => {
  it('mirar a +X es yaw 0', () => {
    expect(lookAngles(vec3(0, 0, 0), vec3(100, 0, 0)).yaw).toBeCloseTo(0, 6);
  });

  it('mirar a +Y (la izquierda) es yaw 90', () => {
    expect(lookAngles(vec3(0, 0, 0), vec3(0, 100, 0)).yaw).toBeCloseTo(90, 6);
  });

  it('el pitch es positivo al mirar hacia abajo', () => {
    // Misma convencion que la simulacion, donde forward.z = -sin(pitch).
    expect(lookAngles(vec3(0, 0, 0), vec3(100, 0, -100)).pitch).toBeCloseTo(45, 6);
    expect(lookAngles(vec3(0, 0, 0), vec3(100, 0, 100)).pitch).toBeCloseTo(-45, 6);
  });
});

describe('camara de muerte', () => {
  it('acaba mirando al asesino', () => {
    // Muere mirando a +X y el asesino esta justo detras.
    const cam = createDeathCamera(vec3(0, 0, 100), 0, 0, 7);
    const killer = vec3(-800, 0, 100);

    settle(cam, killer, 3, 60);

    expect(Math.abs(angleDelta(cam.yaw, 180))).toBeLessThan(1);
  });

  it('gira por el camino corto', () => {
    const cam = createDeathCamera(vec3(0, 0, 100), 170, 0, 7);
    // El asesino esta a yaw -170: son 20 grados por un lado y 340 por el otro.
    const killer = vec3(
      Math.cos((-170 * Math.PI) / 180) * 800,
      Math.sin((-170 * Math.PI) / 180) * 800,
      100,
    );

    updateDeathCamera(cam, killer, 1 / 60);

    // Un solo paso: si fuera por el camino largo, el yaw bajaria hacia 150.
    expect(angleDelta(170, cam.yaw)).toBeGreaterThan(0);
  });

  it('sin asesino se queda mirando el punto de impacto', () => {
    const cam = createDeathCamera(vec3(0, 0, 100), 0, 0, null);

    settle(cam, null, 3, 60);

    // El impacto queda justo debajo de la camara: mira hacia abajo del todo.
    expect(cam.pitch).toBeGreaterThan(80);
  });

  it('el giro tarda lo mismo a 30 que a 240 fps', () => {
    const lento = createDeathCamera(vec3(0, 0, 100), 0, 0, 7);
    const rapido = createDeathCamera(vec3(0, 0, 100), 0, 0, 7);
    const killer = vec3(0, 800, 100);

    settle(lento, killer, 0.5, 30);
    settle(rapido, killer, 0.5, 240);

    expect(Math.abs(angleDelta(lento.yaw, rapido.yaw))).toBeLessThan(2);
  });

  it('un parpadeo largo no se pasa de largo', () => {
    const cam = createDeathCamera(vec3(0, 0, 100), 0, 0, 7);
    const killer = vec3(0, 800, 100);

    // Una pestana en segundo plano puede devolver un dt enorme. El suavizado
    // exponencial se acerca al objetivo sin rebasarlo nunca, que es justo lo
    // que un paso lineal de velocidad por dt no garantiza.
    updateDeathCamera(cam, killer, 30);

    expect(cam.yaw).toBeGreaterThan(80);
    expect(cam.yaw).toBeLessThanOrEqual(90);
  });
});
