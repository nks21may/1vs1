/**
 * Banco de pruebas del coste de dibujar el mapa.
 *
 * Compara las dos formas de construir la malla estatica sobre el mismo mapa,
 * la misma escena y el mismo frame:
 *
 * - **Una malla por caja**, que es como estaba. Se reproduce aqui porque es lo
 *   que hay que medir; no vive en el juego.
 * - **Fusionada por material**, que es lo que hace `buildWorldMesh`.
 *
 * Lo que se mide de verdad son las llamadas de dibujo y los triangulos, que no
 * dependen de la GPU. El tiempo por fotograma se da como referencia relativa:
 * estas capturas corren sobre SwiftShader (render por software), que no sirve
 * para juzgar rendimiento absoluto.
 */

import {
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  Vector3,
} from 'three';

import { MAPS, vec3, type Brush, type GameMap } from '@neonduel/shared';

import { buildWorldMesh } from './render/world.js';

/** Materiales del mapa real, para que el reparto por material sea realista. */
const MATERIALS = ['floor', 'wall', 'platform', 'cover', 'stair', 'accent'] as const;

/**
 * Mapa grande de prueba: una rejilla de cajas repartidas por los materiales.
 * No es jugable ni pretende serlo; lo unico que importa es cuantos brushes hay
 * y de cuantos materiales distintos.
 */
const bigMap = (side: number): GameMap => {
  const brushes: Brush[] = [];
  const step = 160;
  const origin = (-side / 2) * step;

  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const x = origin + i * step;
      const y = origin + j * step;
      const height = 40 + ((i * 7 + j * 13) % 5) * 30;
      brushes.push({
        min: vec3(x, y, 0),
        max: vec3(x + 110, y + 110, height),
        material: MATERIALS[(i + j) % MATERIALS.length],
      });
    }
  }

  return {
    name: 'BENCH',
    brushes,
    spawns: [
      { pos: vec3(origin, origin, 200), yaw: 0 },
      { pos: vec3(-origin, -origin, 200), yaw: 180 },
    ],
    bounds: {
      min: vec3(origin - step, origin - step, -100),
      max: vec3(-origin + step, -origin + step, 900),
    },
    killZ: -200,
  };
};

/** La construccion anterior: una malla por caja. Solo existe para comparar. */
const buildOneMeshPerBrush = (map: GameMap): Mesh[] => {
  const materials = new Map<string, MeshStandardMaterial>();
  return map.brushes.map((brush) => {
    const key = brush.material ?? 'default';
    let material = materials.get(key);
    if (!material) {
      material = new MeshStandardMaterial({ color: 0x223044, roughness: 0.9 });
      materials.set(key, material);
    }

    const sizeX = brush.max.x - brush.min.x;
    const sizeY = brush.max.z - brush.min.z;
    const sizeZ = brush.max.y - brush.min.y;
    const mesh = new Mesh(new BoxGeometry(sizeX, sizeY, sizeZ), material);
    mesh.position.set(
      (brush.min.x + brush.max.x) / 2,
      (brush.min.z + brush.max.z) / 2,
      -(brush.min.y + brush.max.y) / 2,
    );
    return mesh;
  });
};

export interface BenchResult {
  brushes: number;
  /** Objetos que el renderer recorre en la escena. */
  objects: number;
  /** Llamadas de dibujo por fotograma: la medida que no depende de la GPU. */
  calls: number;
  triangles: number;
  /** Milisegundos por fotograma, mediana de las muestras. */
  frameMs: number;
  buildMs: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Dibuja `frames` fotogramas y devuelve las cuentas del ultimo. */
const measure = (
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  frames: number,
): { calls: number; triangles: number; frameMs: number } => {
  const samples: number[] = [];
  for (let i = 0; i < frames; i++) {
    const start = performance.now();
    renderer.render(scene, camera);
    samples.push(performance.now() - start);
  }
  return {
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    frameMs: Math.round(median(samples) * 100) / 100,
  };
};

const countObjects = (scene: Scene): number => {
  let total = 0;
  scene.traverse(() => {
    total += 1;
  });
  return total;
};

/** Mide un mapa concreto de las dos maneras, sobre la misma escena y camara. */
const benchOf = (map: GameMap, frames: number): Record<string, BenchResult> => {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Falta el lienzo');

  const renderer = new WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(1280, 720, false);

  const camera = new PerspectiveCamera(74, 1280 / 720, 1, 40000);
  const extent = Math.max(map.bounds.max.x - map.bounds.min.x, map.bounds.max.y - map.bounds.min.y);
  camera.position.set(0, extent * 0.55, extent * 0.8);
  camera.up.set(0, 1, 0);
  camera.lookAt(new Vector3(0, 0, 0));

  const results: Record<string, BenchResult> = {};

  for (const mode of ['una malla por caja', 'fusionada por material'] as const) {
    const scene = new Scene();
    const buildStart = performance.now();
    if (mode === 'una malla por caja')
      for (const mesh of buildOneMeshPerBrush(map)) scene.add(mesh);
    else scene.add(buildWorldMesh(map));
    const buildMs = Math.round((performance.now() - buildStart) * 100) / 100;

    renderer.info.reset();
    const { calls, triangles, frameMs } = measure(renderer, scene, camera, frames);
    results[mode] = {
      brushes: map.brushes.length,
      objects: countObjects(scene),
      calls,
      triangles,
      frameMs,
      buildMs,
    };
  }

  renderer.dispose();
  return results;
};

/**
 * Corre el banco sobre el mapa sintetico. Se expone en `window` para poder
 * llamarlo desde fuera con distintos tamanos sin recargar la pagina.
 */
const run = (side = 22, frames = 40): Record<string, BenchResult> => benchOf(bigMap(side), frames);

/** Y sobre los mapas de verdad, que es el numero que importa hoy. */
const runMaps = (frames = 40): Record<string, Record<string, BenchResult>> =>
  Object.fromEntries(Object.entries(MAPS).map(([name, map]) => [name, benchOf(map, frames)]));

declare global {
  interface Window {
    runWorldBench: typeof run;
    runMapsBench: typeof runMaps;
  }
}

window.runWorldBench = run;
window.runMapsBench = runMaps;

const output = document.getElementById('output');
if (output) output.textContent = JSON.stringify({ mapas: runMaps(), sintetico: run() }, null, 2);
