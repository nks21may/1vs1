/**
 * Malla del mapa.
 *
 * No se dibuja nada: se comprueba la forma del grafo de la escena, que es lo
 * que decide cuantas llamadas de dibujo cuesta un mapa. Un brush es una caja,
 * pero no tiene por que ser una malla, y esa diferencia es la que le pone (o
 * le quita) techo al tamano de un mapa.
 */

import { Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import { vec3, type Brush, type GameMap } from '@neonduel/shared';

import { buildWorldMesh } from '../src/render/world.js';

/**
 * Mapa sintetico. No usa el material `floor` a proposito: su textura se genera
 * con un canvas, que fuera del navegador no existe, y aqui lo que se mide es el
 * agrupado, no las texturas.
 */
const mapWith = (brushes: Brush[]): GameMap => ({
  name: 'TEST',
  brushes,
  spawns: [
    { pos: vec3(-100, 0, 0), yaw: 0 },
    { pos: vec3(100, 0, 0), yaw: 180 },
  ],
  bounds: { min: vec3(-2000, -2000, -100), max: vec3(2000, 2000, 800) },
  killZ: -200,
});

const box = (x: number, material: string): Brush => ({
  min: vec3(x, 0, 0),
  max: vec3(x + 50, 50, 50),
  material,
});

/** Cajas repartidas por el eje X para que no se solapen. */
const boxes = (count: number, material: string, from = 0): Brush[] =>
  Array.from({ length: count }, (_, i) => box(from + i * 80, material));

const meshesOf = (map: GameMap): Mesh[] =>
  buildWorldMesh(map).children.filter((child): child is Mesh => child instanceof Mesh);

const triangles = (mesh: Mesh): number => {
  const index = mesh.geometry.getIndex();
  const count = index ? index.count : mesh.geometry.getAttribute('position').count;
  return count / 3;
};

describe('malla del mapa', () => {
  it('las cajas del mismo material acaban en una sola malla', () => {
    const meshes = meshesOf(mapWith(boxes(6, 'wall')));

    expect(meshes).toHaveLength(1);
  });

  it('cuantas mallas hay no depende de cuantos brushes tenga el mapa', () => {
    // Este es el punto de la tarea: con una malla por caja, el coste de dibujar
    // el mapa crece con el numero de brushes aunque la geometria sea trivial.
    const pocos = meshesOf(mapWith(boxes(6, 'wall')));
    const muchos = meshesOf(mapWith(boxes(600, 'wall')));

    expect(muchos).toHaveLength(pocos.length);
  });

  it('una malla por material, no una por caja', () => {
    const meshes = meshesOf(
      mapWith([...boxes(4, 'wall'), ...boxes(4, 'platform', 5000), ...boxes(4, 'stair', 10000)]),
    );

    expect(meshes).toHaveLength(3);
  });

  it('la geometria sigue entera despues de fusionarla', () => {
    // Doce triangulos por caja: si al fusionar se perdiera una, el mapa tendria
    // agujeros por los que no se puede pasar pero si se ve.
    const meshes = meshesOf(mapWith(boxes(20, 'wall')));
    const total = meshes.reduce((sum, mesh) => sum + triangles(mesh), 0);

    expect(total).toBe(20 * 12);
  });

  it('las coberturas anaden su tira luminosa, y tambien fusionada', () => {
    // Todas en la misma mitad del mapa: las tiras se agrupan por lado, porque
    // el color con el que brillan lo decide en que mitad estan.
    const sinTira = meshesOf(mapWith(boxes(5, 'wall', -1000)));
    const conTira = meshesOf(mapWith(boxes(5, 'cover', -1000)));

    // La cobertura son dos mallas: la caja y la tira del canto.
    expect(sinTira).toHaveLength(1);
    expect(conTira).toHaveLength(2);
  });

  it('las aristas siguen siendo un solo trazo por color', () => {
    const group = buildWorldMesh(mapWith(boxes(40, 'wall')));
    const lines = group.children.filter((child) => child.type === 'LineSegments');

    // Tres colores como mucho, uno por mitad del mapa.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(3);
  });
});
