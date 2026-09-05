/**
 * Interpolacion de entidades remotas.
 *
 * Al rival no se le predice: se le dibuja en el pasado. El cliente guarda las
 * ultimas instantaneas y renderiza el instante `ahora - INTERP_DELAY_MS`,
 * interpolando entre las dos que lo rodean. A cambio de ~100 ms de retraso
 * visual, el movimiento del rival es continuo aunque lleguen paquetes con
 * jitter o se pierda alguno; el retraso lo compensa el servidor al rebobinar.
 *
 * Se usa la hora de recepcion local como referencia, no el reloj del servidor:
 * evita tener que sincronizar relojes y absorbe el jitter igual de bien.
 */

import {
  INTERP_DELAY_MS,
  type PlayerSnapshot,
  SNAPSHOT_FLAG,
  type Vec3,
  type WeaponId,
  lerp,
  lerpAngle,
  vec3,
} from '@neonduel/shared';

export interface TimedSnapshot {
  /** Momento local de recepcion, en ms. */
  receivedAt: number;
  players: PlayerSnapshot[];
}

export interface InterpolatedPlayer {
  id: number;
  name: string;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  ducking: boolean;
  onGround: boolean;
  alive: boolean;
  health: number;
  weapon: WeaponId;
  score: number;
}

/** Instantaneas guardadas: algo mas de medio segundo de historial. */
const MAX_SNAPSHOTS = 48;

const toInterpolated = (
  snapshot: PlayerSnapshot,
  extra?: Partial<InterpolatedPlayer>,
): InterpolatedPlayer => ({
  id: snapshot.id,
  name: snapshot.name,
  pos: vec3(snapshot.x, snapshot.y, snapshot.z),
  vel: vec3(snapshot.vx, snapshot.vy, snapshot.vz),
  yaw: snapshot.yaw,
  pitch: snapshot.pitch,
  ducking: (snapshot.flags & SNAPSHOT_FLAG.DUCKING) !== 0,
  onGround: (snapshot.flags & SNAPSHOT_FLAG.ON_GROUND) !== 0,
  alive: (snapshot.flags & SNAPSHOT_FLAG.ALIVE) !== 0,
  health: snapshot.health,
  weapon: snapshot.weapon,
  score: snapshot.score,
  ...extra,
});

export class InterpolationBuffer {
  private snapshots: TimedSnapshot[] = [];

  constructor(private readonly delayMs: number = INTERP_DELAY_MS) {}

  get size(): number {
    return this.snapshots.length;
  }

  get delay(): number {
    return this.delayMs;
  }

  push(players: PlayerSnapshot[], receivedAt: number): void {
    this.snapshots.push({ players, receivedAt });
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
  }

  clear(): void {
    this.snapshots = [];
  }

  /**
   * Estado de las entidades en el instante de render correspondiente a `now`.
   * `excludeId` deja fuera al jugador local, que va predicho aparte.
   */
  sample(now: number, excludeId?: number): InterpolatedPlayer[] {
    if (this.snapshots.length === 0) return [];

    const renderTime = now - this.delayMs;
    const newest = this.snapshots[this.snapshots.length - 1]!;
    const oldest = this.snapshots[0]!;

    // Sin datos suficientes todavia, o retraso demasiado grande: se muestra el
    // extremo mas cercano en lugar de extrapolar (extrapolar produce tirones).
    if (renderTime >= newest.receivedAt) return this.playersOf(newest, excludeId);
    if (renderTime <= oldest.receivedAt) return this.playersOf(oldest, excludeId);

    for (let i = 0; i < this.snapshots.length - 1; i++) {
      const a = this.snapshots[i]!;
      const b = this.snapshots[i + 1]!;
      if (renderTime >= a.receivedAt && renderTime <= b.receivedAt) {
        const span = b.receivedAt - a.receivedAt;
        const t = span > 0 ? (renderTime - a.receivedAt) / span : 0;
        return this.interpolate(a, b, t, excludeId);
      }
    }

    return this.playersOf(newest, excludeId);
  }

  private playersOf(snapshot: TimedSnapshot, excludeId?: number): InterpolatedPlayer[] {
    return snapshot.players.filter((p) => p.id !== excludeId).map((p) => toInterpolated(p));
  }

  private interpolate(
    a: TimedSnapshot,
    b: TimedSnapshot,
    t: number,
    excludeId?: number,
  ): InterpolatedPlayer[] {
    return a.players
      .filter((p) => p.id !== excludeId)
      .map((from) => {
        const to = b.players.find((p) => p.id === from.id);
        if (!to) return toInterpolated(from);

        return toInterpolated(from, {
          pos: vec3(lerp(from.x, to.x, t), lerp(from.y, to.y, t), lerp(from.z, to.z, t)),
          vel: vec3(lerp(from.vx, to.vx, t), lerp(from.vy, to.vy, t), lerp(from.vz, to.vz, t)),
          // Los angulos se interpolan por el camino corto: si no, girar 180
          // grados haria que el modelo diese una vuelta entera al reves.
          yaw: lerpAngle(from.yaw, to.yaw, t),
          pitch: lerp(from.pitch, to.pitch, t),
          // Los estados discretos saltan en el punto medio en lugar de mezclarse.
          ...(t >= 0.5
            ? {
                ducking: (to.flags & SNAPSHOT_FLAG.DUCKING) !== 0,
                onGround: (to.flags & SNAPSHOT_FLAG.ON_GROUND) !== 0,
                alive: (to.flags & SNAPSHOT_FLAG.ALIVE) !== 0,
                health: to.health,
                weapon: to.weapon,
                score: to.score,
              }
            : {}),
        });
      });
  }
}
