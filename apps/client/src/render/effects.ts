/**
 * Efectos de disparo: trazadores, impactos y chispas.
 *
 * Todo se recicla desde grupos preasignados. Crear y destruir geometrias a 10
 * disparos por segundo provocaria microtirones por recoleccion de basura justo
 * en los momentos de mas tension, que es cuando peor sientan.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';

import type { Vec3 } from '@neonduel/shared';

import { PALETTE } from './scene.js';

const TRACER_POOL = 24;
const IMPACT_POOL = 32;
const SPARK_COUNT = 10;
/** Duracion de un impacto, en segundos. */
const IMPACT_LIFE = 0.24;

const toThreeVec = (v: Vec3): Vector3 => new Vector3(v.x, v.z, -v.y);

interface Tracer {
  line: Line;
  life: number;
  duration: number;
}

interface Impact {
  flash: Mesh;
  sparks: Points;
  velocities: Float32Array;
  life: number;
}

export class EffectSystem {
  readonly group = new Group();
  private readonly tracers: Tracer[] = [];
  private readonly impacts: Impact[] = [];
  private tracerIndex = 0;
  private impactIndex = 0;

  constructor() {
    for (let i = 0; i < TRACER_POOL; i++) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
      const line = new Line(
        geometry,
        new LineBasicMaterial({
          color: new Color(PALETTE.tracer),
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      line.frustumCulled = false;
      line.visible = false;
      this.group.add(line);
      this.tracers.push({ line, life: 0, duration: 0.08 });
    }

    for (let i = 0; i < IMPACT_POOL; i++) {
      // Un impacto de bala es pequeno: a bocajarro, un destello grande tapa
      // justo la parte de la pantalla donde se esta apuntando.
      const flash = new Mesh(
        new PlaneGeometry(5, 5),
        new MeshBasicMaterial({
          color: new Color(PALETTE.impact),
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      flash.visible = false;

      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3),
      );
      const sparks = new Points(
        geometry,
        new PointsMaterial({
          color: new Color(PALETTE.impact),
          // Tamano fijo en pixeles: con atenuacion por distancia, una chispa a
          // un metro de la camara se dibuja como un cuadrado de media pantalla.
          size: 3,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      sparks.frustumCulled = false;
      sparks.visible = false;

      this.group.add(flash, sparks);
      this.impacts.push({
        flash,
        sparks,
        velocities: new Float32Array(SPARK_COUNT * 3),
        life: 0,
      });
    }
  }

  /** Traza la linea de una bala entre dos puntos del mundo. */
  addTracer(from: Vec3, to: Vec3, color: number = PALETTE.tracer): void {
    const tracer = this.tracers[this.tracerIndex]!;
    this.tracerIndex = (this.tracerIndex + 1) % this.tracers.length;

    const start = toThreeVec(from);
    const end = toThreeVec(to);
    const positions = tracer.line.geometry.getAttribute('position') as BufferAttribute;
    positions.setXYZ(0, start.x, start.y, start.z);
    positions.setXYZ(1, end.x, end.y, end.z);
    positions.needsUpdate = true;

    (tracer.line.material as LineBasicMaterial).color.setHex(color);
    // Los trazos largos duran un poco mas: recorren mas pantalla.
    tracer.duration = 0.05 + Math.min(0.06, start.distanceTo(end) / 20000);
    tracer.life = tracer.duration;
    tracer.line.visible = true;
  }

  /** Destello y chispas en el punto de impacto, orientados a la superficie. */
  addImpact(position: Vec3, normal: Vec3, color: number = PALETTE.impact): void {
    const impact = this.impacts[this.impactIndex]!;
    this.impactIndex = (this.impactIndex + 1) % this.impacts.length;

    const point = toThreeVec(position);
    const dir = toThreeVec(normal);

    impact.flash.position.copy(point).addScaledVector(dir, 0.5);
    if (dir.lengthSq() > 0.001) impact.flash.lookAt(point.clone().add(dir));
    (impact.flash.material as MeshBasicMaterial).color.setHex(color);
    impact.flash.visible = true;

    const positions = impact.sparks.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < SPARK_COUNT; i++) {
      positions.setXYZ(i, point.x, point.y, point.z);
      // Chispas repartidas en el hemisferio de la normal, con algo de gravedad.
      const spread = new Vector3(
        dir.x + (Math.random() - 0.5) * 1.6,
        dir.y + (Math.random() - 0.5) * 1.6 + 0.4,
        dir.z + (Math.random() - 0.5) * 1.6,
      )
        .normalize()
        .multiplyScalar(90 + Math.random() * 130);
      impact.velocities[i * 3] = spread.x;
      impact.velocities[i * 3 + 1] = spread.y;
      impact.velocities[i * 3 + 2] = spread.z;
    }
    positions.needsUpdate = true;
    (impact.sparks.material as PointsMaterial).color.setHex(color);
    impact.sparks.visible = true;
    impact.life = IMPACT_LIFE;
  }

  update(dt: number): void {
    for (const tracer of this.tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      const material = tracer.line.material as LineBasicMaterial;
      material.opacity = Math.max(0, tracer.life / tracer.duration);
      if (tracer.life <= 0) tracer.line.visible = false;
    }

    for (const impact of this.impacts) {
      if (impact.life <= 0) continue;
      impact.life -= dt;
      const t = Math.max(0, impact.life / IMPACT_LIFE);

      const flashMaterial = impact.flash.material as MeshBasicMaterial;
      flashMaterial.opacity = t * t * 0.8;
      impact.flash.scale.setScalar(0.5 + (1 - t) * 0.8);

      const positions = impact.sparks.geometry.getAttribute('position') as BufferAttribute;
      const array = positions.array as Float32Array;
      for (let i = 0; i < SPARK_COUNT; i++) {
        array[i * 3]! += impact.velocities[i * 3]! * dt;
        array[i * 3 + 1]! += impact.velocities[i * 3 + 1]! * dt;
        array[i * 3 + 2]! += impact.velocities[i * 3 + 2]! * dt;
        impact.velocities[i * 3 + 1]! -= 900 * dt;
      }
      positions.needsUpdate = true;
      (impact.sparks.material as PointsMaterial).opacity = t * 0.85;

      if (impact.life <= 0) {
        impact.flash.visible = false;
        impact.sparks.visible = false;
      }
    }
  }
}
