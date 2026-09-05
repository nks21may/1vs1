// Banco de pruebas de la pose del avatar (T08). No se publica: coloca varios
// avatares con velocidades fijas para ver de un vistazo si la postura cuenta lo
// que hace cada uno.
import { MAX_SPEED, vec3 } from '@neonduel/shared';

import type { InterpolatedPlayer } from './game/interpolation.js';
import { PlayerAvatar } from './render/players.js';
import { createRenderContext } from './render/scene.js';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const render = createRenderContext(canvas);
render.setSize(1200, 420);
render.setBloomEnabled(true);
render.setFov(70);

const base = (x: number): InterpolatedPlayer => ({
  id: 1,
  name: 'T',
  pos: vec3(x, 0, 0),
  vel: vec3(),
  yaw: 0,
  pitch: 0,
  ducking: false,
  onGround: true,
  alive: true,
  health: 100,
  weapon: 'rifle',
  score: 0,
});

// Cuatro casos, de izquierda a derecha: parado, corriendo de frente,
// desplazandose de lado y en el aire.
const casos: { x: number; vel: ReturnType<typeof vec3>; onGround: boolean; ticks: number }[] = [
  { x: -270, vel: vec3(), onGround: true, ticks: 1 },
  // Los ticks llevan la zancada hasta su apertura maxima, que es donde se ve.
  { x: -90, vel: vec3(MAX_SPEED, 0, 0), onGround: true, ticks: 11 },
  { x: 90, vel: vec3(0, -MAX_SPEED, 0), onGround: true, ticks: 11 },
  { x: 270, vel: vec3(MAX_SPEED * 0.8, 0, 120), onGround: false, ticks: 4 },
];

for (const caso of casos) {
  const avatar = new PlayerAvatar(0x2ce8ff);
  render.scene.add(avatar.root);
  const player = { ...base(caso.x), vel: caso.vel, onGround: caso.onGround };
  for (let i = 0; i < caso.ticks; i++) avatar.update(player, 1 / 64);
}

// Camara de perfil: la zancada y la inclinacion se leen de lado.
render.camera.position.set(0, 52, 330);
render.camera.lookAt(0, 38, 0);

requestAnimationFrame(() => {
  render.render();
  requestAnimationFrame(() => {
    (window as unknown as { __avatarReady: boolean }).__avatarReady = true;
  });
});
