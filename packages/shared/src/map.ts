/**
 * Mapas del juego.
 *
 * La geometria se construye por codigo a partir de cajas alineadas a los ejes:
 * el mismo dato alimenta la colision del servidor y la malla del cliente, asi
 * que es imposible que lo que se ve y lo que se choca se desincronicen.
 *
 * De cada mapa solo se disena la mitad oeste (x < 0) y se refleja: la simetria
 * exacta es un requisito de un 1v1 competitivo, y reflejar la garantiza por
 * construccion en lugar de por revision.
 *
 * Hay dos, y son opuestos a proposito: ATRIUM es una arena abierta con juego
 * vertical, y CONDUIT son pasillos y esquinas cerradas. Lo que se juega bien en
 * uno no se juega igual en el otro, que es la gracia de tener mas de uno.
 */

import type { Brush, CollisionWorld } from './collision.js';
import { STEP_SIZE } from './constants.js';
import { type Vec3, vec3 } from './math.js';

export type MaterialId =
  | 'floor'
  | 'wall'
  | 'platform'
  | 'cover'
  | 'accent'
  | 'stair';

export interface SpawnPoint {
  pos: Vec3;
  yaw: number;
}

export interface GameMap {
  readonly name: string;
  readonly brushes: readonly Brush[];
  readonly spawns: readonly [SpawnPoint, SpawnPoint];
  readonly bounds: { min: Vec3; max: Vec3 };
  /** Por debajo de esta altura se considera caida al vacio. */
  readonly killZ: number;
}

const box = (
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  material: MaterialId,
): Brush => ({
  min: vec3(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)),
  max: vec3(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)),
  material,
});

/** Refleja un brush respecto al plano X = 0. */
export const mirrorBrushX = (brush: Brush): Brush => ({
  ...brush,
  min: vec3(-brush.max.x, brush.min.y, brush.min.z),
  max: vec3(-brush.min.x, brush.max.y, brush.max.z),
});

const ATRIUM_HALF_X = 1152;
const ATRIUM_HALF_Y = 896;
const ATRIUM_WALL_HEIGHT = 640;
const ATRIUM_WALL_THICKNESS = 64;

/** Altura de peldano: nunca debe superar `STEP_SIZE` o habria que saltar. */
export const STAIR_RISE = 16;

interface StairOptions {
  /** Eje por el que desciende la escalera. */
  axis: 'x' | 'y';
  /** Borde superior: coordenada donde la escalera esta a `topZ`. */
  start: number;
  /** Sentido del descenso (+1 o -1). */
  direction: 1 | -1;
  /** Extension en el eje perpendicular. */
  crossMin: number;
  crossMax: number;
  topZ: number;
  /** Profundidad de cada peldano. */
  run: number;
}

/**
 * Escalera descendente desde `topZ` hasta el suelo. Los peldanos miden
 * `STAIR_RISE`, por debajo de `STEP_SIZE`, de modo que se suben caminando.
 */
const stairs = ({
  axis,
  start,
  direction,
  crossMin,
  crossMax,
  topZ,
  run,
}: StairOptions): Brush[] => {
  const steps = Math.ceil(topZ / STAIR_RISE);
  const out: Brush[] = [];

  for (let i = 0; i < steps; i++) {
    const near = start + direction * i * run;
    const far = start + direction * (i + 1) * run;
    const height = topZ - i * STAIR_RISE;
    const [lo, hi] = direction > 0 ? [near, far] : [far, near];

    out.push(
      axis === 'x'
        ? box(lo, crossMin, 0, hi, crossMax, height, 'stair')
        : box(crossMin, lo, 0, crossMax, hi, height, 'stair'),
    );
  }
  return out;
};

const SPAWN_TOWER_Z = 96;
const BALCONY_Z = 128;

const buildBrushes = (): Brush[] => {
  // --- Piezas centrales, simetricas por si mismas ---
  const central: Brush[] = [
    box(-ATRIUM_HALF_X, -ATRIUM_HALF_Y, -64, ATRIUM_HALF_X, ATRIUM_HALF_Y, 0, 'floor'),

    // Muros perimetrales.
    box(-ATRIUM_HALF_X - ATRIUM_WALL_THICKNESS, -ATRIUM_HALF_Y, 0, -ATRIUM_HALF_X, ATRIUM_HALF_Y, ATRIUM_WALL_HEIGHT, 'wall'),
    box(ATRIUM_HALF_X, -ATRIUM_HALF_Y, 0, ATRIUM_HALF_X + ATRIUM_WALL_THICKNESS, ATRIUM_HALF_Y, ATRIUM_WALL_HEIGHT, 'wall'),
    box(
      -ATRIUM_HALF_X - ATRIUM_WALL_THICKNESS,
      -ATRIUM_HALF_Y - ATRIUM_WALL_THICKNESS,
      0,
      ATRIUM_HALF_X + ATRIUM_WALL_THICKNESS,
      -ATRIUM_HALF_Y,
      ATRIUM_WALL_HEIGHT,
      'wall',
    ),
    box(
      -ATRIUM_HALF_X - ATRIUM_WALL_THICKNESS,
      ATRIUM_HALF_Y,
      0,
      ATRIUM_HALF_X + ATRIUM_WALL_THICKNESS,
      ATRIUM_HALF_Y + ATRIUM_WALL_THICKNESS,
      ATRIUM_WALL_HEIGHT,
      'wall',
    ),

    // Monolito central: corta la linea de tiro directa entre los dos spawns y
    // obliga a elegir por que lado se abre la ronda.
    box(-112, -256, 0, 112, 256, 448, 'accent'),

    // Balcones norte y sur: el juego alto del mapa.
    box(-960, 448, 0, 960, ATRIUM_HALF_Y, BALCONY_Z, 'platform'),
    box(-960, -ATRIUM_HALF_Y, 0, 960, -448, BALCONY_Z, 'platform'),
    // La barandilla deja libres los extremos, que es por donde suben las escaleras.
    box(-700, 416, BALCONY_Z, 700, 448, BALCONY_Z + 48, 'cover'),
    box(-700, -448, BALCONY_Z, 700, -416, BALCONY_Z + 48, 'cover'),
  ];

  // --- Mitad oeste (se refleja al este) ---
  const west: Brush[] = [
    // Torre de spawn y su rampa escalonada hacia el centro.
    box(-ATRIUM_HALF_X, -160, 0, -960, 160, SPAWN_TOWER_Z, 'platform'),
    ...stairs({
      axis: 'x',
      start: -960,
      direction: 1,
      crossMin: -160,
      crossMax: 160,
      topZ: SPAWN_TOWER_Z,
      run: 40,
    }),

    // Escaleras a los balcones, pegadas al fondo para no cortar el carril central.
    ...stairs({
      axis: 'y',
      start: 448,
      direction: -1,
      crossMin: -900,
      crossMax: -740,
      topZ: BALCONY_Z,
      run: 36,
    }),
    ...stairs({
      axis: 'y',
      start: -448,
      direction: 1,
      crossMin: -900,
      crossMax: -740,
      topZ: BALCONY_Z,
      run: 36,
    }),

    // Cobertura del carril central: obliga a comprometerse con un lado.
    box(-660, -144, 0, -540, 144, 96, 'cover'),

    // Cajas bajas junto al spawn, para el peek desde la salida.
    box(-1100, 300, 0, -980, 440, 64, 'cover'),
    box(-1100, -440, 0, -980, -300, 64, 'cover'),

    // Pilares que rompen los angulos largos por las bandas.
    box(-384, 640, 0, -320, 768, 384, 'accent'),
    box(-384, -768, 0, -320, -640, 384, 'accent'),
  ];

  const east = west.map(mirrorBrushX);
  return [...central, ...west, ...east];
};

export const ATRIUM: GameMap = {
  name: 'ATRIUM',
  brushes: buildBrushes(),
  spawns: [
    { pos: vec3(-1056, 0, SPAWN_TOWER_Z + 8), yaw: 0 },
    { pos: vec3(1056, 0, SPAWN_TOWER_Z + 8), yaw: 180 },
  ],
  bounds: {
    min: vec3(-ATRIUM_HALF_X - ATRIUM_WALL_THICKNESS, -ATRIUM_HALF_Y - ATRIUM_WALL_THICKNESS, -256),
    max: vec3(ATRIUM_HALF_X + ATRIUM_WALL_THICKNESS, ATRIUM_HALF_Y + ATRIUM_WALL_THICKNESS, ATRIUM_WALL_HEIGHT),
  },
  killZ: -256,
};


// --- CONDUIT -----------------------------------------------------------------

const CONDUIT_HALF_X = 1152;
const CONDUIT_HALF_Y = 768;
const CONDUIT_WALL_HEIGHT = 512;
const CONDUIT_WALL_THICKNESS = 64;

/**
 * CONDUIT: tres carriles paralelos separados por muros macizos.
 *
 * Al contrario que ATRIUM, aqui casi no hay angulos largos ni juego vertical:
 * se avanza por pasillos y se pelea en las esquinas y en los huecos que
 * comunican los carriles. El bloque central tapa la linea entre los dos spawns,
 * asi que la ronda empieza eligiendo carril, y cambiar de idea a mitad de ronda
 * cuesta cruzar por un hueco que el rival puede estar mirando.
 */
const buildConduitBrushes = (): Brush[] => {
  const h = CONDUIT_WALL_HEIGHT;
  const t = CONDUIT_WALL_THICKNESS;

  const central: Brush[] = [
    box(-CONDUIT_HALF_X, -CONDUIT_HALF_Y, -64, CONDUIT_HALF_X, CONDUIT_HALF_Y, 0, 'floor'),

    // Muros perimetrales.
    box(-CONDUIT_HALF_X - t, -CONDUIT_HALF_Y, 0, -CONDUIT_HALF_X, CONDUIT_HALF_Y, h, 'wall'),
    box(CONDUIT_HALF_X, -CONDUIT_HALF_Y, 0, CONDUIT_HALF_X + t, CONDUIT_HALF_Y, h, 'wall'),
    box(-CONDUIT_HALF_X - t, -CONDUIT_HALF_Y - t, 0, CONDUIT_HALF_X + t, -CONDUIT_HALF_Y, h, 'wall'),
    box(-CONDUIT_HALF_X - t, CONDUIT_HALF_Y, 0, CONDUIT_HALF_X + t, CONDUIT_HALF_Y + t, h, 'wall'),

    // Bloque central: sin el, los dos spawns se verian de frente.
    box(-288, -288, 0, 288, 288, h, 'accent'),

    // Tramo central de los muros que separan los carriles. Los huecos quedan
    // entre este tramo y los de los extremos, ya en la mitad de cada jugador.
    box(-544, 384, 0, 544, 448, h, 'wall'),
    box(-544, -448, 0, 544, -384, h, 'wall'),
  ];

  const west: Brush[] = [
    // Tramos exteriores de los muros de carril: dejan un hueco de 224 unidades
    // por el que se cambia de carril, uno a cada lado del mapa.
    box(-CONDUIT_HALF_X, 384, 0, -768, 448, h, 'wall'),
    box(-CONDUIT_HALF_X, -448, 0, -768, -384, h, 'wall'),

    // Esquina ciega junto al hueco: quien cruza no ve el pasillo entero de
    // golpe, y quien espera no puede cubrir el hueco y el pasillo a la vez.
    box(-672, 448, 0, -608, 608, h, 'wall'),
    box(-672, -608, 0, -608, -448, h, 'wall'),

    // Pilares que parten los pasillos laterales por la mitad.
    box(-352, 560, 0, -256, 656, h, 'accent'),
    box(-352, -656, 0, -256, -560, h, 'accent'),

    // Cobertura baja del carril central, para poder cruzarlo agachado.
    box(-640, -96, 0, -512, 96, 96, 'cover'),
    box(-928, 176, 0, -832, 304, 64, 'cover'),
    box(-928, -304, 0, -832, -176, 64, 'cover'),
  ];

  return [...central, ...west, ...west.map(mirrorBrushX)];
};

export const CONDUIT: GameMap = {
  name: 'CONDUIT',
  brushes: buildConduitBrushes(),
  spawns: [
    { pos: vec3(-1056, 0, 8), yaw: 0 },
    { pos: vec3(1056, 0, 8), yaw: 180 },
  ],
  bounds: {
    min: vec3(-CONDUIT_HALF_X - CONDUIT_WALL_THICKNESS, -CONDUIT_HALF_Y - CONDUIT_WALL_THICKNESS, -256),
    max: vec3(CONDUIT_HALF_X + CONDUIT_WALL_THICKNESS, CONDUIT_HALF_Y + CONDUIT_WALL_THICKNESS, CONDUIT_WALL_HEIGHT),
  },
  killZ: -256,
};

/** Todos los mapas jugables, por nombre. */
export const MAPS: Readonly<Record<string, GameMap>> = {
  ATRIUM,
  CONDUIT,
};

export const DEFAULT_MAP = ATRIUM;

/** Busca un mapa por nombre, sin distinguir mayusculas. `undefined` si no existe. */
export const getMap = (name: string | null | undefined): GameMap | undefined =>
  name ? MAPS[name.toUpperCase()] : undefined;

/** Comprobacion de invariantes usada por los tests del mapa. */
export const MAX_STAIR_RISE = STAIR_RISE;
export const stairFitsStepSize = STAIR_RISE <= STEP_SIZE;

export const createCollisionWorld = (map: GameMap): CollisionWorld => ({
  brushes: map.brushes,
  bounds: map.bounds,
});

export const ATRIUM_WORLD: CollisionWorld = createCollisionWorld(ATRIUM);
