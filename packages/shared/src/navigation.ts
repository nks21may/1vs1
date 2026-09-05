/**
 * Navegacion por rejilla.
 *
 * El bot perseguia en linea recta y rodeaba a tientas cuando dejaba de avanzar.
 * En una arena abierta cuela; en un mapa de pasillos se queda dando vueltas
 * contra una esquina. Esto le da un grafo de posiciones donde cabe de pie y por
 * las que puede pasar caminando, y una busqueda de camino sobre el.
 *
 * El grafo se deduce de la geometria del mapa con la misma colision que usa la
 * simulacion, no de una lista escrita a mano: un mapa nuevo trae su navegacion
 * sin que nadie tenga que anotar nada, que es la unica forma de que no se
 * quede desfasada cuando alguien mueve una pared.
 */

import { type CollisionWorld, isPositionSolid, traceBox } from './collision.js';
import { STEP_SIZE } from './constants.js';
import { type GameMap, createCollisionWorld } from './map.js';
import { type Vec3, vec3 } from './math.js';
import { playerMins, playerMaxs } from './movement.js';

/**
 * Separacion entre nodos. Tiene que ser menor que la huella del escalon mas
 * largo del mapa (40 unidades de fondo por 16 de alto en ATRIUM): con 64, dos
 * nodos seguidos de una escalera se llevarian mas de `STEP_SIZE` y las
 * escaleras quedarian marcadas como intransitables.
 */
export const NAV_STEP = 32;

export interface NavGraph {
  readonly nodes: readonly Vec3[];
  /** Indices de los vecinos de cada nodo. */
  readonly links: readonly (readonly number[])[];
}

const VECINOS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const claveCelda = (cx: number, cy: number): string => `${cx},${cy}`;

/** Altura del suelo en una columna, o `null` si ahi no se puede estar de pie. */
const alturaDeSuelo = (world: CollisionWorld, x: number, y: number, map: GameMap): number | null => {
  const mins = playerMins();
  const maxs = playerMaxs(false);
  const desde = vec3(x, y, map.bounds.max.z - 1);
  const hasta = vec3(x, y, map.bounds.min.z);

  const trace = traceBox(world, desde, hasta, mins, maxs);
  if (trace.startSolid || !trace.hit) return null;

  const z = desde.z + (hasta.z - desde.z) * trace.fraction;
  // Un suelo por debajo del vacio no vale de nada: el bot se caeria.
  if (z <= map.killZ) return null;
  if (isPositionSolid(world, vec3(x, y, z), mins, maxs)) return null;
  return z;
};

/**
 * Construye el grafo de un mapa. Es caro (barre todo el mapa con la colision
 * real), asi que se cachea por mapa: se hace una vez por proceso.
 */
export const buildNavGraph = (map: GameMap): NavGraph => {
  const world = createCollisionWorld(map);
  const mins = playerMins();
  const maxs = playerMaxs(false);

  const nodes: Vec3[] = [];
  const indice = new Map<string, number>();

  const desdeX = Math.ceil(map.bounds.min.x / NAV_STEP);
  const hastaX = Math.floor(map.bounds.max.x / NAV_STEP);
  const desdeY = Math.ceil(map.bounds.min.y / NAV_STEP);
  const hastaY = Math.floor(map.bounds.max.y / NAV_STEP);

  for (let cx = desdeX; cx <= hastaX; cx++) {
    for (let cy = desdeY; cy <= hastaY; cy++) {
      const x = cx * NAV_STEP;
      const y = cy * NAV_STEP;
      const z = alturaDeSuelo(world, x, y, map);
      if (z === null) continue;
      indice.set(claveCelda(cx, cy), nodes.length);
      nodes.push(vec3(x, y, z));
    }
  }

  const links: number[][] = nodes.map(() => []);
  for (const [clave, i] of indice) {
    const [cx, cy] = clave.split(',').map(Number) as [number, number];
    for (const [dx, dy] of VECINOS) {
      const j = indice.get(claveCelda(cx + dx, cy + dy));
      if (j === undefined) continue;

      const a = nodes[i]!;
      const b = nodes[j]!;
      // Un escalon mas alto de lo que se sube andando no es un vecino.
      if (Math.abs(b.z - a.z) > STEP_SIZE) continue;
      // Y hay que poder ir de uno a otro: dos celdas a los lados de una pared
      // son vecinas en la rejilla pero no en el mapa.
      const alto = Math.max(a.z, b.z);
      const trace = traceBox(world, vec3(a.x, a.y, alto), vec3(b.x, b.y, alto), mins, maxs);
      if (trace.hit || trace.startSolid) continue;

      links[i]!.push(j);
    }
  }

  // El barrido tambien encuentra sitio de pie encima de los muros y del
  // monolito: son posiciones validas, pero no se llega a ellas. Se conserva
  // solo lo que se alcanza andando desde los spawns, que es lo que el bot puede
  // recorrer de verdad. Asi el grafo es de una pieza por construccion y no hay
  // que preguntarse si un camino existe.
  return soloAlcanzable({ nodes, links }, map);
};

/** Recorta el grafo a la parte conectada con los puntos de aparicion. */
const soloAlcanzable = (graph: NavGraph, map: GameMap): NavGraph => {
  const visto = new Uint8Array(graph.nodes.length);
  const cola: number[] = [];
  for (const spawn of map.spawns) {
    const i = nearestNode(graph, spawn.pos);
    if (i >= 0 && !visto[i]) {
      visto[i] = 1;
      cola.push(i);
    }
  }

  let cabeza = 0;
  while (cabeza < cola.length) {
    for (const vecino of graph.links[cola[cabeza++]!]!) {
      if (visto[vecino]) continue;
      visto[vecino] = 1;
      cola.push(vecino);
    }
  }

  // Reindexado: los enlaces guardan indices, asi que hay que traducirlos.
  const nuevoIndice = new Int32Array(graph.nodes.length).fill(-1);
  const nodes: Vec3[] = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    if (!visto[i]) continue;
    nuevoIndice[i] = nodes.length;
    nodes.push(graph.nodes[i]!);
  }
  const links = nodes.map((): number[] => []);
  for (let i = 0; i < graph.nodes.length; i++) {
    const destino = nuevoIndice[i]!;
    if (destino < 0) continue;
    for (const vecino of graph.links[i]!) {
      const traducido = nuevoIndice[vecino]!;
      if (traducido >= 0) links[destino]!.push(traducido);
    }
  }
  return { nodes, links };
};

const cache = new Map<GameMap, NavGraph>();

/** Grafo del mapa, construido la primera vez que se pide. */
export const navGraphOf = (map: GameMap): NavGraph => {
  const existente = cache.get(map);
  if (existente) return existente;
  const grafo = buildNavGraph(map);
  cache.set(map, grafo);
  return grafo;
};

/** Nodo mas cercano a un punto, midiendo tambien en vertical. */
export const nearestNode = (graph: NavGraph, pos: Vec3): number => {
  let mejor = -1;
  let mejorDistancia = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i]!;
    // La altura pesa mas que la distancia horizontal: dos plantas de un mapa
    // caen en la misma columna, y coger la equivocada manda al bot al piso de
    // abajo cuando su objetivo esta arriba.
    const d = (n.x - pos.x) ** 2 + (n.y - pos.y) ** 2 + ((n.z - pos.z) * 4) ** 2;
    if (d < mejorDistancia) {
      mejorDistancia = d;
      mejor = i;
    }
  }
  return mejor;
};

/**
 * Camino entre dos puntos, como lista de posiciones. Vacia si no hay ruta.
 *
 * Es una busqueda en anchura y no A*: la rejilla es pequena y todos los pasos
 * cuestan lo mismo, asi que la heuristica no compraria nada y si complicaria
 * el codigo.
 */
export const findPath = (graph: NavGraph, from: Vec3, to: Vec3): Vec3[] => {
  const inicio = nearestNode(graph, from);
  const meta = nearestNode(graph, to);
  if (inicio < 0 || meta < 0) return [];
  if (inicio === meta) return [graph.nodes[meta]!];

  const previo = new Int32Array(graph.nodes.length).fill(-1);
  const visto = new Uint8Array(graph.nodes.length);
  visto[inicio] = 1;

  const cola: number[] = [inicio];
  let cabeza = 0;
  while (cabeza < cola.length) {
    const actual = cola[cabeza++]!;
    if (actual === meta) break;
    for (const vecino of graph.links[actual]!) {
      if (visto[vecino]) continue;
      visto[vecino] = 1;
      previo[vecino] = actual;
      cola.push(vecino);
    }
  }

  if (!visto[meta]) return [];

  const camino: Vec3[] = [];
  for (let n = meta; n !== -1; n = previo[n]!) camino.push(graph.nodes[n]!);
  return camino.reverse();
};
