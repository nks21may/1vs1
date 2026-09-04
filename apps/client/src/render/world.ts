/**
 * Malla del mapa.
 *
 * Se construye a partir de los mismos brushes que usa la colision, de modo que
 * lo que se ve y lo que bloquea son literalmente el mismo dato. Cada material
 * logico ("suelo", "muro", "cobertura"...) se traduce a un material de three, y
 * las aristas se dibujan como lineas emisivas: es lo que da el aspecto de neon
 * y, sobre todo, hace legible la geometria en un mapa tan oscuro.
 */

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Brush, GameMap } from '@neonduel/shared';

import { PALETTE, createGridTexture } from './scene.js';

/** Un brush situado a partir de esta X se considera del lado calido. */
const SIDE_THRESHOLD = 220;

const materialFor = (id: string | undefined): MeshStandardMaterial => {
  switch (id) {
    case 'floor':
      return new MeshStandardMaterial({
        color: PALETTE.floor,
        roughness: 0.92,
        metalness: 0.05,
        map: createGridTexture(256, 4, '#22354f', '#11161f'),
      });
    case 'wall':
      return new MeshStandardMaterial({
        color: PALETTE.wall,
        roughness: 0.95,
        metalness: 0.02,
      });
    case 'platform':
      return new MeshStandardMaterial({
        color: PALETTE.platform,
        roughness: 0.85,
        metalness: 0.12,
      });
    case 'cover':
      return new MeshStandardMaterial({
        color: PALETTE.cover,
        roughness: 0.7,
        metalness: 0.25,
      });
    case 'stair':
      return new MeshStandardMaterial({
        color: PALETTE.stair,
        roughness: 0.88,
        metalness: 0.1,
      });
    case 'accent':
      return new MeshStandardMaterial({
        color: PALETTE.accent,
        roughness: 0.4,
        metalness: 0.5,
      });
    default:
      return new MeshStandardMaterial({ color: 0x101520, roughness: 0.9 });
  }
};

/** Colores de las tiras luminosas y de las aristas, por mitad del mapa. */
const SIDE_COLORS: Record<'cool' | 'warm' | 'neutral', number> = {
  cool: 0x2ce8ff,
  warm: 0xff3ea5,
  neutral: 0x8ea8c8,
};

/** Material emisivo compartido por todas las tiras de un mismo lado. */
const stripMaterial = (
  side: 'cool' | 'warm' | 'neutral',
  cache: Map<string, MeshStandardMaterial>,
): MeshStandardMaterial => {
  const key = `strip:${side}`;
  let material = cache.get(key);
  if (!material) {
    material = new MeshStandardMaterial({
      color: 0x05070c,
      emissive: new Color(SIDE_COLORS[side]),
      emissiveIntensity: 0.5,
      roughness: 0.4,
    });
    cache.set(key, material);
  }
  return material;
};

/** Caja de un brush ya convertida a coordenadas de three. */
const brushBox = (brush: Brush) => {
  const sizeX = brush.max.x - brush.min.x;
  const sizeY = brush.max.z - brush.min.z; // altura
  const sizeZ = brush.max.y - brush.min.y;
  const center = new Vector3(
    (brush.min.x + brush.max.x) / 2,
    (brush.min.z + brush.max.z) / 2,
    -(brush.min.y + brush.max.y) / 2,
  );
  return { sizeX, sizeY, sizeZ, center };
};

/** Repite la textura del suelo cada 128 unidades para que la rejilla no se estire. */
const tileFloorTexture = (material: MeshStandardMaterial, sizeX: number, sizeZ: number) => {
  if (!material.map) return;
  material.map.repeat.set(Math.max(1, sizeX / 512), Math.max(1, sizeZ / 512));
  material.map.needsUpdate = true;
};

export const buildWorldMesh = (map: GameMap): Group => {
  const group = new Group();
  const materials = new Map<string, MeshStandardMaterial>();
  const edgesBySide: Record<'cool' | 'warm' | 'neutral', BufferGeometry[]> = {
    cool: [],
    warm: [],
    neutral: [],
  };

  for (const brush of map.brushes) {
    const { sizeX, sizeY, sizeZ, center } = brushBox(brush);
    const key = brush.material ?? 'default';

    let material = materials.get(key);
    if (!material) {
      material = materialFor(brush.material);
      materials.set(key, material);
    }
    if (key === 'floor') tileFloorTexture(material, sizeX, sizeZ);

    const geometry = new BoxGeometry(sizeX, sizeY, sizeZ);
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(center);
    group.add(mesh);

    // Tira luminosa en el canto superior de los volumenes que se usan como
    // cobertura. Ademas de la estetica, es informacion: marca a que altura
    // puede uno resguardarse y desde donde se puede asomar.
    // Solo en las coberturas: en las plataformas grandes (balcones, torres de
    // spawn) la tira ocupa media pantalla y el brillo tapa el juego.
    if (key === 'cover') {
      const side =
        center.x < -SIDE_THRESHOLD ? 'cool' : center.x > SIDE_THRESHOLD ? 'warm' : 'neutral';
      const strip = new Mesh(
        new BoxGeometry(sizeX + 1, 1.2, sizeZ + 1),
        stripMaterial(side, materials),
      );
      strip.position.set(center.x, center.y + sizeY / 2, center.z);
      group.add(strip);
    }

    // Las aristas se acumulan y se fusionan al final: un unico LineSegments por
    // color en lugar de uno por caja.
    const edges = new EdgesGeometry(geometry, 20);
    edges.translate(center.x, center.y, center.z);

    const side =
      center.x < -SIDE_THRESHOLD ? 'cool' : center.x > SIDE_THRESHOLD ? 'warm' : 'neutral';
    edgesBySide[side].push(edges);
  }

  const edgeColors: Record<'cool' | 'warm' | 'neutral', number> = {
    cool: PALETTE.edgeCool,
    warm: PALETTE.edgeWarm,
    neutral: 0x3d5170,
  };

  const disposables: BufferGeometry[] = [];

  for (const side of ['cool', 'warm', 'neutral'] as const) {
    const geometries = edgesBySide[side];
    if (geometries.length === 0) continue;

    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;

    disposables.push(merged);
    const lines = new LineSegments(
      merged,
      new LineBasicMaterial({
        color: new Color(edgeColors[side]),
        transparent: true,
        opacity: 0.85,
        fog: true,
      }),
    );
    group.add(lines);
  }

  return group;
};

/**
 * Libera la malla de un mapa. Cambiar de mapa entre partidas sin esto va
 * dejando geometrias y materiales en la GPU que ya no dibuja nadie.
 */
export const disposeWorldMesh = (group: Group): void => {
  group.traverse((object) => {
    const conGeometria = object as { geometry?: { dispose(): void }; material?: unknown };
    conGeometria.geometry?.dispose();
    const material = conGeometria.material;
    for (const m of Array.isArray(material) ? material : [material]) {
      (m as { dispose?: () => void } | undefined)?.dispose?.();
    }
  });
};
