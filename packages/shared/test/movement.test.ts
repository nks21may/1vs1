/**
 * Tests del motor de movimiento.
 *
 * Se comprueban las propiedades que definen la sensacion de juego (altura de
 * salto, frenada por counter-strafe, ganancia de velocidad en el aire) en lugar
 * de valores internos: son las que no pueden romperse sin que el juego cambie.
 */

import { describe, expect, it } from 'vitest';

import { BUTTON, GRAVITY, JUMP_IMPULSE, MAX_SPEED, TICK_DT } from '../src/constants.js';
import { length2D, vec3 } from '../src/math.js';
import {
  accelerate,
  airAccelerate,
  applyFriction,
  createMoveState,
  eyeHeight,
  moveStep,
  wishDirection,
} from '../src/movement.js';
import { brush, cmd, flatWorld } from './helpers.js';

const world = flatWorld();

/** Coloca al jugador apoyado en el suelo tras un tick en reposo. */
const groundedState = (x = 0, y = 0) => {
  const state = createMoveState(vec3(x, y, 1));
  moveStep(state, cmd(0), world);
  return state;
};

describe('applyFriction', () => {
  it('no hace nada por debajo del umbral de velocidad', () => {
    const vel = vec3(0.05, 0, 0);
    applyFriction(vel, TICK_DT);
    expect(vel.x).toBe(0.05);
  });

  it('frena mas rapido a baja velocidad que de forma puramente proporcional', () => {
    const slow = vec3(40, 0, 0);
    const fast = vec3(240, 0, 0);
    applyFriction(slow, TICK_DT);
    applyFriction(fast, TICK_DT);

    const slowLoss = (40 - slow.x) / 40;
    const fastLoss = (240 - fast.x) / 240;
    // Por debajo de STOP_SPEED el frenado es constante, luego proporcionalmente mayor.
    expect(slowLoss).toBeGreaterThan(fastLoss);
  });
});

describe('accelerate', () => {
  it('nunca supera wishSpeed en la direccion deseada', () => {
    const vel = vec3();
    const dir = vec3(1, 0, 0);
    for (let i = 0; i < 200; i++) accelerate(vel, dir, 250, 5.5, TICK_DT);
    expect(vel.x).toBeLessThanOrEqual(250 + 1e-6);
    expect(vel.x).toBeGreaterThan(249);
  });

  it('no aporta nada si ya se supera wishSpeed en esa direccion', () => {
    const vel = vec3(400, 0, 0);
    accelerate(vel, vec3(1, 0, 0), 250, 5.5, TICK_DT);
    expect(vel.x).toBe(400);
  });
});

describe('airAccelerate', () => {
  it('limita la ganancia al tope de wishspeed aereo', () => {
    const vel = vec3();
    for (let i = 0; i < 200; i++) airAccelerate(vel, vec3(1, 0, 0), 250, TICK_DT);
    // El tope de 30 u/s se aplica a la proyeccion, no al modulo.
    expect(vel.x).toBeCloseTo(30, 1);
  });

  it('permite ganar velocidad perpendicular aunque ya se vaya rapido (air-strafe)', () => {
    const vel = vec3(250, 0, 0);
    airAccelerate(vel, vec3(0, 1, 0), 250, TICK_DT);
    expect(length2D(vel)).toBeGreaterThan(250);
  });
});

describe('wishDirection', () => {
  it('normaliza las diagonales para que no sean mas rapidas', () => {
    const { dir, magnitude } = wishDirection(BUTTON.FORWARD | BUTTON.RIGHT, 0);
    expect(magnitude).toBe(1);
    expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(1, 6);
  });

  it('las direcciones opuestas se cancelan', () => {
    const { magnitude } = wishDirection(BUTTON.FORWARD | BUTTON.BACK, 0);
    expect(magnitude).toBe(0);
  });

  it('sigue el yaw de la vista', () => {
    const { dir } = wishDirection(BUTTON.FORWARD, 90);
    expect(dir.x).toBeCloseTo(0, 6);
    expect(dir.y).toBeCloseTo(1, 6);
  });
});

describe('moveStep en el suelo', () => {
  it('alcanza la velocidad maxima corriendo de frente', () => {
    const state = groundedState();
    for (let i = 0; i < 64; i++) moveStep(state, cmd(BUTTON.FORWARD), world);
    expect(length2D(state.vel)).toBeCloseTo(MAX_SPEED, 0);
    expect(state.onGround).toBe(true);
  });

  it('el counter-strafe frena casi en seco', () => {
    const state = groundedState();
    for (let i = 0; i < 64; i++) moveStep(state, cmd(BUTTON.FORWARD), world);
    const runSpeed = length2D(state.vel);

    // Ocho ticks (125 ms) pulsando la direccion contraria.
    for (let i = 0; i < 8; i++) moveStep(state, cmd(BUTTON.BACK), world);
    expect(length2D(state.vel)).toBeLessThan(runSpeed * 0.25);
  });

  it('caminar limita la velocidad respecto a correr', () => {
    const run = groundedState();
    const walk = groundedState();
    for (let i = 0; i < 64; i++) {
      moveStep(run, cmd(BUTTON.FORWARD), world);
      moveStep(walk, cmd(BUTTON.FORWARD | BUTTON.WALK), world);
    }
    expect(length2D(walk.vel)).toBeLessThan(length2D(run.vel) * 0.6);
  });

  it('agacharse reduce la velocidad y baja la camara', () => {
    const state = groundedState();
    for (let i = 0; i < 64; i++) moveStep(state, cmd(BUTTON.FORWARD | BUTTON.DUCK), world);
    expect(state.ducking).toBe(true);
    expect(state.duckProgress).toBe(1);
    expect(length2D(state.vel)).toBeLessThan(MAX_SPEED * 0.5);
    expect(eyeHeight(state.duckProgress)).toBeLessThan(eyeHeight(0));
  });
});

describe('salto', () => {
  it('alcanza la altura teorica v^2 / 2g', () => {
    const state = groundedState();
    const startZ = state.pos.z;
    let maxZ = startZ;

    moveStep(state, cmd(BUTTON.JUMP), world);
    for (let i = 0; i < 64; i++) {
      moveStep(state, cmd(0), world);
      maxZ = Math.max(maxZ, state.pos.z);
    }

    // La altura continua es v^2/2g (57 unidades), pero al integrar en pasos
    // discretos el apice se mide medio tick tarde: hay que sumar v*dt/2. Ese
    // termino tambien existe en Source y es por lo que 64 tick "salta mas".
    const expected =
      (JUMP_IMPULSE * JUMP_IMPULSE) / (2 * GRAVITY) + (JUMP_IMPULSE * TICK_DT) / 2;
    expect(maxZ - startZ).toBeGreaterThan(expected - 0.5);
    expect(maxZ - startZ).toBeLessThan(expected + 0.5);
  });

  it('vuelve a tocar suelo', () => {
    const state = groundedState();
    moveStep(state, cmd(BUTTON.JUMP), world);
    for (let i = 0; i < 128; i++) moveStep(state, cmd(0), world);
    expect(state.onGround).toBe(true);
    expect(state.pos.z).toBeCloseTo(0, 1);
  });

  it('no permite auto-bhop manteniendo pulsado el salto', () => {
    const state = groundedState();
    // Aterriza con el boton pulsado: no debe volver a saltar sin soltarlo.
    moveStep(state, cmd(BUTTON.JUMP), world);
    let jumps = 0;
    for (let i = 0; i < 200; i++) {
      const events = moveStep(state, cmd(BUTTON.JUMP), world);
      if (events.jumped) jumps++;
    }
    expect(jumps).toBe(0);
  });

  it('recorta la velocidad al saltar por encima del tope de bunnyhop', () => {
    const state = groundedState();
    state.vel = vec3(600, 0, 0);
    const events = moveStep(state, cmd(BUTTON.JUMP), world);
    expect(events.jumped).toBe(true);
    expect(length2D(state.vel)).toBeLessThanOrEqual(MAX_SPEED * 1.1 + 1);
  });
});

describe('air-strafing', () => {
  it('gana velocidad girando la vista hacia el lado del strafe', () => {
    const state = groundedState();
    state.vel = vec3(MAX_SPEED, 0, 0);
    moveStep(state, cmd(BUTTON.JUMP), world);
    const initialSpeed = length2D(state.vel);

    let yaw = 0;
    for (let i = 0; i < 40; i++) {
      // Girar a la derecha (yaw decreciente) mientras se pulsa D.
      yaw -= 0.35;
      moveStep(state, cmd(BUTTON.RIGHT, yaw), world);
      if (state.onGround) break;
    }

    expect(length2D(state.vel)).toBeGreaterThan(initialSpeed + 5);
  });

  it('no gana velocidad si no se gira la vista', () => {
    const state = groundedState();
    state.vel = vec3(MAX_SPEED, 0, 0);
    moveStep(state, cmd(BUTTON.JUMP), world);
    const initialSpeed = length2D(state.vel);

    for (let i = 0; i < 40; i++) {
      moveStep(state, cmd(BUTTON.FORWARD), world);
      if (state.onGround) break;
    }
    expect(length2D(state.vel)).toBeLessThanOrEqual(initialSpeed + 0.5);
  });
});

describe('colision durante el movimiento', () => {
  it('no atraviesa una pared ni con velocidad absurda', () => {
    const walled = flatWorld([brush(100, -256, 0, 132, 256, 256)]);
    const state = createMoveState(vec3(0, 0, 1));
    moveStep(state, cmd(0), walled);
    state.vel = vec3(6000, 0, 0);

    for (let i = 0; i < 30; i++) moveStep(state, cmd(BUTTON.FORWARD), walled);
    expect(state.pos.x).toBeLessThan(100);
  });

  it('desliza a lo largo de la pared en vez de detenerse en seco', () => {
    const walled = flatWorld([brush(100, -1024, 0, 132, 1024, 256)]);
    const state = createMoveState(vec3(0, 0, 1));
    moveStep(state, cmd(0), walled);

    // Avanzar en diagonal contra la pared: debe progresar en Y.
    for (let i = 0; i < 64; i++) {
      moveStep(state, cmd(BUTTON.FORWARD | BUTTON.LEFT, 0), walled);
    }
    expect(state.pos.x).toBeLessThan(100);
    expect(Math.abs(state.pos.y)).toBeGreaterThan(50);
  });

  it('sube escalones de hasta STEP_SIZE sin saltar', () => {
    const stepped = flatWorld([brush(100, -256, 0, 400, 256, 16)]);
    const state = createMoveState(vec3(0, 0, 1));
    moveStep(state, cmd(0), stepped);

    for (let i = 0; i < 64; i++) moveStep(state, cmd(BUTTON.FORWARD), stepped);
    expect(state.pos.x).toBeGreaterThan(150);
    expect(state.pos.z).toBeCloseTo(16, 0);
  });

  it('no sube un muro mas alto que STEP_SIZE', () => {
    const blocked = flatWorld([brush(100, -256, 0, 400, 256, 64)]);
    const state = createMoveState(vec3(0, 0, 1));
    moveStep(state, cmd(0), blocked);

    for (let i = 0; i < 64; i++) moveStep(state, cmd(BUTTON.FORWARD), blocked);
    expect(state.pos.z).toBeLessThan(1);
    expect(state.pos.x).toBeLessThan(100);
  });
});

describe('duck-jump', () => {
  it('agacharse en el aire eleva los pies y permite subir a plataformas altas', () => {
    const ledge = flatWorld([brush(120, -256, 0, 600, 256, 64)]);
    const state = createMoveState(vec3(0, 0, 1));
    moveStep(state, cmd(0), ledge);
    state.vel = vec3(250, 0, 0);

    moveStep(state, cmd(BUTTON.JUMP | BUTTON.FORWARD), ledge);
    for (let i = 0; i < 40; i++) {
      moveStep(state, cmd(BUTTON.FORWARD | BUTTON.DUCK, 0), ledge);
      if (state.onGround && state.pos.x > 120) break;
    }

    expect(state.pos.z).toBeGreaterThan(60);
    expect(state.pos.x).toBeGreaterThan(120);
  });

  it('no se levanta si no hay espacio libre encima', () => {
    const crawl = flatWorld([brush(-512, -512, 60, 512, 512, 200)]);
    const state = createMoveState(vec3(0, 0, 1));
    for (let i = 0; i < 32; i++) moveStep(state, cmd(BUTTON.DUCK), crawl);
    expect(state.ducking).toBe(true);

    for (let i = 0; i < 32; i++) moveStep(state, cmd(0), crawl);
    // El techo esta a 60 unidades: el hull de pie (72) no cabe.
    expect(state.ducking).toBe(true);
  });
});

describe('determinismo', () => {
  it('dos simulaciones con los mismos comandos dan el mismo estado', () => {
    const commands = Array.from({ length: 120 }, (_, i) => ({
      seq: i,
      buttons: i % 3 === 0 ? BUTTON.FORWARD | BUTTON.JUMP : BUTTON.FORWARD | BUTTON.RIGHT,
      yaw: i * 1.7,
      pitch: 0,
      dt: TICK_DT,
    }));

    const runOnce = () => {
      const state = createMoveState(vec3(0, 0, 1));
      for (const command of commands) moveStep(state, command, world);
      return state;
    };

    const a = runOnce();
    const b = runOnce();
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
    expect(a.onGround).toBe(b.onGround);
  });
});
