/**
 * Compensacion de latencia.
 *
 * El servidor guarda un historial corto de las posiciones de cada jugador. Al
 * resolver un disparo, rebobina el mundo al instante que el atacante estaba
 * viendo realmente (su reloj menos su interpolacion) y evalua el hitscan ahi.
 * Sin esto habria que "liderar" al rival en proporcion al ping.
 *
 * La latencia con la que se rebobina la mide el propio servidor
 * (`LatencyEstimator`), y ademas va acotada por `MAX_REWIND_MS`: ni se declara
 * ni, aunque se falsee, se puede disparar a un pasado arbitrario.
 */

import {
  LAG_COMPENSATION_HISTORY_TICKS,
  LATENCY_SAMPLES,
  MAX_LATENCY_SAMPLE_MS,
  MAX_REWIND_MS,
} from './constants.js';
import type { HitboxSource } from './hitscan.js';
import { clamp, lerpVec3, vec3 } from './math.js';

export interface PlayerSnapshotSample {
  id: number;
  pos: { x: number; y: number; z: number };
  ducking: boolean;
  alive: boolean;
}

export interface HistoryFrame {
  tick: number;
  /** Marca de tiempo del servidor en milisegundos. */
  timeMs: number;
  players: PlayerSnapshotSample[];
}

/**
 * Buffer circular de frames del mundo. Tamano fijo: media ronda de historial no
 * aporta nada y el coste de memoria debe ser constante.
 */
export class LagCompensationBuffer {
  private readonly frames: (HistoryFrame | null)[];
  private writeIndex = 0;
  private count = 0;

  constructor(private readonly capacity: number = LAG_COMPENSATION_HISTORY_TICKS) {
    this.frames = new Array<HistoryFrame | null>(capacity).fill(null);
  }

  get size(): number {
    return this.count;
  }

  record(frame: HistoryFrame): void {
    this.frames[this.writeIndex] = frame;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  /** Frames del mas antiguo al mas reciente. */
  toArray(): HistoryFrame[] {
    const out: HistoryFrame[] = [];
    for (let i = 0; i < this.count; i++) {
      const index = (this.writeIndex - this.count + i + this.capacity * 2) % this.capacity;
      const frame = this.frames[index];
      if (frame) out.push(frame);
    }
    return out;
  }

  get newest(): HistoryFrame | null {
    if (this.count === 0) return null;
    return this.frames[(this.writeIndex - 1 + this.capacity) % this.capacity] ?? null;
  }

  get oldest(): HistoryFrame | null {
    if (this.count === 0) return null;
    return this.frames[(this.writeIndex - this.count + this.capacity * 2) % this.capacity] ?? null;
  }

  /**
   * Estado interpolado del mundo en `timeMs`. Si el instante cae fuera del
   * historial se devuelve el extremo mas cercano.
   */
  sampleAt(timeMs: number): PlayerSnapshotSample[] {
    const frames = this.toArray();
    if (frames.length === 0) return [];

    const first = frames[0]!;
    const last = frames[frames.length - 1]!;
    if (timeMs <= first.timeMs) return first.players;
    if (timeMs >= last.timeMs) return last.players;

    for (let i = 0; i < frames.length - 1; i++) {
      const a = frames[i]!;
      const b = frames[i + 1]!;
      if (timeMs >= a.timeMs && timeMs <= b.timeMs) {
        const span = b.timeMs - a.timeMs;
        const t = span > 0 ? (timeMs - a.timeMs) / span : 0;
        return interpolateFrames(a, b, t);
      }
    }
    return last.players;
  }
}

/** Interpola dos frames jugador a jugador (los que faltan se toman de `a`). */
export const interpolateFrames = (
  a: HistoryFrame,
  b: HistoryFrame,
  t: number,
): PlayerSnapshotSample[] =>
  a.players.map((sampleA) => {
    const sampleB = b.players.find((p) => p.id === sampleA.id);
    if (!sampleB) return sampleA;
    const pos = lerpVec3(
      vec3(sampleA.pos.x, sampleA.pos.y, sampleA.pos.z),
      vec3(sampleB.pos.x, sampleB.pos.y, sampleB.pos.z),
      t,
    );
    return {
      id: sampleA.id,
      pos,
      // Los estados discretos no se interpolan: se toma el mas cercano.
      ducking: t < 0.5 ? sampleA.ducking : sampleB.ducking,
      alive: t < 0.5 ? sampleA.alive : sampleB.alive,
    };
  });

/**
 * Latencia de un cliente, medida por el servidor.
 *
 * Cada paquete de entrada dice que instantanea esta viendo el cliente. El
 * servidor sabe cuando envio esa instantanea, asi que la distancia hasta su
 * reloj es el viaje de ida y vuelta completo. La medida es enteramente suya: el
 * cliente no declara ningun numero, solo senala un tick que el servidor mismo
 * produjo.
 *
 * Se guarda el **minimo** de la ventana, no la ultima medida. La red solo puede
 * anadir retraso, nunca quitarlo, asi que el minimo es la mejor estimacion del
 * camino real; y de paso hace inutil la trampa que importa, que es inflar la
 * latencia justo en el momento de disparar: para mover el minimo hay que
 * sostener la mentira durante toda la ventana.
 *
 * Lo que ningun servidor puede distinguir es a un cliente que *dice* ir
 * retrasado de uno que lo va de verdad. Contra eso solo esta el tope de
 * `MAX_REWIND_MS`, que es el que acota el rebobinado maximo.
 */
export class LatencyEstimator {
  private readonly samples: number[];
  private writeIndex = 0;
  private count = 0;

  constructor(private readonly capacity: number = LATENCY_SAMPLES) {
    this.samples = new Array<number>(capacity).fill(0);
  }

  get size(): number {
    return this.count;
  }

  /**
   * Anota un viaje de ida y vuelta observado. Una medida negativa significa que
   * el cliente dice haber visto una instantanea que aun no existe: se anota
   * como cero, que es no compensarle nada.
   */
  record(roundTripMs: number): void {
    this.samples[this.writeIndex] = clamp(roundTripMs, 0, MAX_LATENCY_SAMPLE_MS);
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  /** Latencia de ida, que es la mitad del viaje. Cero mientras no haya medidas. */
  get oneWayMs(): number {
    if (this.count === 0) return 0;
    let min = Infinity;
    for (let i = 0; i < this.count; i++) min = Math.min(min, this.samples[i]!);
    return min / 2;
  }
}

/**
 * Instante al que hay que rebobinar para un cliente concreto.
 * Se acota tanto por seguridad (`MAX_REWIND_MS`) como para no rebobinar al futuro.
 */
export const computeRewindTime = (
  serverTimeMs: number,
  clientLatencyMs: number,
  interpolationDelayMs: number,
): number => {
  const rewind = clamp(clientLatencyMs + interpolationDelayMs, 0, MAX_REWIND_MS);
  return serverTimeMs - rewind;
};

/** Convierte una muestra rebobinada en objetivos de hitscan, excluyendo al tirador. */
export const toHitboxTargets = (
  samples: readonly PlayerSnapshotSample[],
  excludeId: number,
): HitboxSource[] =>
  samples
    .filter((s) => s.id !== excludeId && s.alive)
    .map((s) => ({
      id: s.id,
      pos: vec3(s.pos.x, s.pos.y, s.pos.z),
      ducking: s.ducking,
    }));
