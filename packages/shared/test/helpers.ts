/** Utilidades compartidas por los tests de simulacion. */

import type { Brush, CollisionWorld } from '../src/collision.js';
import { TICK_DT } from '../src/constants.js';
import { type UserCommand } from '../src/movement.js';
import { vec3 } from '../src/math.js';

export const brush = (
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
): Brush => ({ min: vec3(x1, y1, z1), max: vec3(x2, y2, z2) });

/** Mundo de pruebas: un suelo infinito a z = 0. */
export const flatWorld = (extraBrushes: Brush[] = []): CollisionWorld => ({
  brushes: [brush(-4096, -4096, -64, 4096, 4096, 0), ...extraBrushes],
  bounds: { min: vec3(-4096, -4096, -1024), max: vec3(4096, 4096, 4096) },
});

let seq = 0;

export const cmd = (buttons: number, yaw = 0, pitch = 0, dt = TICK_DT): UserCommand => ({
  seq: seq++,
  buttons,
  yaw,
  pitch,
  dt,
});

/** Comando que ademas pide una ranura de arma. */
export const slotCmd = (slot: number, buttons = 0): UserCommand => ({
  ...cmd(buttons),
  slot,
});
