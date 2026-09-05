/**
 * El grafo de navegacion se deduce de la geometria, asi que estos tests son los
 * que dicen si un mapa es realmente recorrible: no comprueban una lista de
 * puntos escrita a mano, sino que desde cualquier sitio se llega a cualquier
 * otro.
 */

import { describe, expect, it } from 'vitest';

import { ATRIUM, CONDUIT, MAPS } from '../src/map.js';
import { NAV_STEP, findPath, navGraphOf } from '../src/navigation.js';
import { createCollisionWorld } from '../src/map.js';
import { isPositionSolid } from '../src/collision.js';
import { playerMaxs, playerMins } from '../src/movement.js';
import { vec3 } from '../src/math.js';

describe.each(Object.entries(MAPS))('navegacion de %s', (_nombre, mapa) => {
  const graph = navGraphOf(mapa);
  const world = createCollisionWorld(mapa);

  it('tiene nodos suficientes para cubrir el mapa', () => {
    expect(graph.nodes.length).toBeGreaterThan(200);
  });

  it('en todos los nodos cabe un jugador de pie', () => {
    for (const nodo of graph.nodes) {
      expect(isPositionSolid(world, nodo, playerMins(), playerMaxs(false))).toBe(false);
    }
  });

  it('ningun enlace sube mas de lo que se sube andando', () => {
    for (let i = 0; i < graph.nodes.length; i++) {
      for (const j of graph.links[i]!) {
        expect(Math.abs(graph.nodes[j]!.z - graph.nodes[i]!.z)).toBeLessThanOrEqual(18);
      }
    }
  });

  it('los enlaces son mutuos', () => {
    for (let i = 0; i < graph.nodes.length; i++) {
      for (const j of graph.links[i]!) {
        expect(graph.links[j]).toContain(i);
      }
    }
  });

  /**
   * El criterio de la tarea: desde cualquier punto se llega a cualquier otro.
   * Se comprueba sobre el grafo entero y no sobre una muestra, que es la unica
   * forma de que un rincon aislado no pase desapercibido.
   */
  it('todo el mapa esta conectado: no hay rincones aislados', () => {
    const visto = new Uint8Array(graph.nodes.length);
    const cola = [0];
    visto[0] = 1;
    let cabeza = 0;
    let alcanzados = 1;
    while (cabeza < cola.length) {
      for (const vecino of graph.links[cola[cabeza++]!]!) {
        if (visto[vecino]) continue;
        visto[vecino] = 1;
        alcanzados++;
        cola.push(vecino);
      }
    }
    expect(alcanzados).toBe(graph.nodes.length);
  });

  it('hay camino entre los dos spawns, y empieza y acaba donde debe', () => {
    const [a, b] = mapa.spawns;
    const camino = findPath(graph, a.pos, b.pos);

    expect(camino.length).toBeGreaterThan(4);
    expect(Math.hypot(camino[0]!.x - a.pos.x, camino[0]!.y - a.pos.y)).toBeLessThan(NAV_STEP * 2);
    const fin = camino[camino.length - 1]!;
    expect(Math.hypot(fin.x - b.pos.x, fin.y - b.pos.y)).toBeLessThan(NAV_STEP * 2);
  });

  it('los pasos del camino son siempre contiguos', () => {
    const [a, b] = mapa.spawns;
    const camino = findPath(graph, a.pos, b.pos);
    for (let i = 1; i < camino.length; i++) {
      const paso = Math.hypot(camino[i]!.x - camino[i - 1]!.x, camino[i]!.y - camino[i - 1]!.y);
      expect(paso).toBeCloseTo(NAV_STEP, 6);
    }
  });
});

describe('caminos concretos', () => {
  it('en ATRIUM sube al balcon, que esta a otra altura', () => {
    const graph = navGraphOf(ATRIUM);
    const camino = findPath(graph, ATRIUM.spawns[0].pos, vec3(0, 700, 128));
    expect(camino.length).toBeGreaterThan(0);
    expect(camino[camino.length - 1]!.z).toBeGreaterThan(100);
  });

  it('en CONDUIT cruza al pasillo del otro lado', () => {
    const graph = navGraphOf(CONDUIT);
    const camino = findPath(graph, vec3(-1056, 0, 8), vec3(640, 640, 8));
    expect(camino.length).toBeGreaterThan(10);
  });

  it('los tejados no cuentan: hay sitio de pie ahi arriba, pero no se llega', () => {
    // El barrido encuentra la cara superior del monolito de ATRIUM (448) y de
    // los muros de CONDUIT (512). Son posiciones validas y aun asi no deben
    // estar en el grafo, o el bot intentaria caminos imposibles.
    const alto = navGraphOf(ATRIUM).nodes.filter((n) => n.z > 200);
    expect(alto).toHaveLength(0);
    expect(navGraphOf(CONDUIT).nodes.filter((n) => n.z > 200)).toHaveLength(0);
  });

  it('el balcon de ATRIUM si esta, que a el se sube por las escaleras', () => {
    expect(navGraphOf(ATRIUM).nodes.some((n) => n.z > 120 && n.z < 140)).toBe(true);
  });

  it('un destino fuera del mapa cae en el nodo mas cercano en vez de fallar', () => {
    const graph = navGraphOf(CONDUIT);
    const camino = findPath(graph, vec3(-1056, 0, 8), vec3(99999, 99999, 0));
    expect(camino.length).toBeGreaterThan(0);
  });
});
