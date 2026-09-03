// Banco de pruebas temporal para comparar el antialiasing (T17). No se publica.
import { ATRIUM } from '@neonduel/shared';

import { applyViewAngles, createRenderContext, toThree } from './render/scene.js';
import { buildWorldMesh } from './render/world.js';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const render = createRenderContext(canvas);
render.scene.add(buildWorldMesh(ATRIUM));
render.setSize(1280, 720);
render.setBloomEnabled(true);
render.setFov(74);

// Salida del spawn oeste mirando en diagonal hacia el monolito central: aristas
// oblicuas de sobra, que es donde se ve el escalonado.
render.camera.position.copy(toThree({ x: -1056, y: 0, z: 160 }));
applyViewAngles(render.camera, 16, -4);

requestAnimationFrame(() => {
  render.render();
  requestAnimationFrame(() => {
    (window as unknown as { __aaReady: boolean }).__aaReady = true;
  });
});
