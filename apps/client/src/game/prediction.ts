/**
 * Prediccion del jugador local y reconciliacion con el servidor.
 *
 * El cliente simula sus propios comandos al instante, sin esperar respuesta: es
 * lo unico que hace que el movimiento se sienta inmediato con 60 ms de ping.
 * Cuando llega la instantanea autoritativa se compara con lo que el cliente
 * habia predicho para ese mismo comando; si difieren, se adopta el estado del
 * servidor y se vuelven a aplicar los comandos aun sin confirmar.
 *
 * Como la simulacion es determinista y compartida, en ausencia de perdida de
 * paquetes la correccion es exactamente cero y no se nota nada.
 */

import {
  type CollisionWorld,
  type PlayerSnapshot,
  type PlayerState,
  SNAPSHOT_FLAG,
  type PlayerTickEvents,
  type UserCommand,
  simulatePlayerTick,
  vec3,
} from '@neonduel/shared';

/** Error de posicion a partir del cual merece la pena corregir (unidades). */
export const RECONCILE_THRESHOLD = 0.1;
/** Comandos sin confirmar que se guardan como maximo. */
const MAX_PENDING = 256;

interface PendingCommand {
  cmd: UserCommand;
  /** Estado *resultante* de aplicar `cmd`, para comparar con el servidor. */
  state: PlayerState;
}

const clonePlayer = (player: PlayerState): PlayerState => ({
  ...player,
  pos: { ...player.pos },
  vel: { ...player.vel },
  ammo: { ...player.ammo },
});

export interface ReconcileResult {
  /** True si hubo que corregir la posicion predicha. */
  corrected: boolean;
  /** Magnitud del error detectado, en unidades. */
  error: number;
  /** Comandos que se han vuelto a aplicar. */
  replayed: number;
}

export class PredictionSystem {
  /** Estado predicho del jugador local: el que se dibuja. */
  readonly player: PlayerState;

  private pending: PendingCommand[] = [];
  private lastCorrection = 0;

  constructor(
    initial: PlayerState,
    private readonly world: CollisionWorld,
  ) {
    this.player = clonePlayer(initial);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Error de la ultima reconciliacion; el HUD lo muestra como diagnostico. */
  get lastError(): number {
    return this.lastCorrection;
  }

  /** Aplica un comando localmente y lo guarda a la espera de confirmacion. */
  apply(cmd: UserCommand): PlayerTickEvents {
    const events = simulatePlayerTick(this.player, cmd, this.world);
    this.pending.push({ cmd, state: clonePlayer(this.player) });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    return events;
  }

  /**
   * Reconcilia con la instantanea del servidor.
   * `ack` es el ultimo comando que el servidor ha procesado.
   */
  reconcile(snapshot: PlayerSnapshot, ack: number): ReconcileResult {
    // Fuera de la prediccion: la vida y la municion siempre mandan del servidor.
    this.player.health = snapshot.health;
    this.player.alive = (snapshot.flags & SNAPSHOT_FLAG.ALIVE) !== 0;

    const index = this.pending.findIndex((entry) => entry.cmd.seq === ack);
    if (index === -1) {
      // No tenemos ese comando (reconexion, respawn o desfase grande): se acepta
      // el estado del servidor tal cual y se empieza de nuevo.
      this.adoptServerState(snapshot);
      this.pending = [];
      this.lastCorrection = 0;
      return { corrected: true, error: 0, replayed: 0 };
    }

    const predicted = this.pending[index]!.state;
    const error = Math.hypot(
      predicted.pos.x - snapshot.x,
      predicted.pos.y - snapshot.y,
      predicted.pos.z - snapshot.z,
    );

    // Los comandos ya confirmados dejan de hacer falta.
    const replayCommands = this.pending.slice(index + 1);
    this.pending = replayCommands.map((entry) => entry);
    this.lastCorrection = error;

    if (error <= RECONCILE_THRESHOLD) {
      return { corrected: false, error, replayed: 0 };
    }

    // Adoptar el estado autoritativo y repetir lo que el servidor aun no ha visto.
    this.adoptServerState(snapshot);
    const replayed: PendingCommand[] = [];
    for (const entry of replayCommands) {
      simulatePlayerTick(this.player, entry.cmd, this.world);
      replayed.push({ cmd: entry.cmd, state: clonePlayer(this.player) });
    }
    this.pending = replayed;

    return { corrected: true, error, replayed: replayed.length };
  }

  /** Coloca al jugador local en el estado que dicta el servidor. */
  private adoptServerState(snapshot: PlayerSnapshot): void {
    this.player.pos = vec3(snapshot.x, snapshot.y, snapshot.z);
    this.player.vel = vec3(snapshot.vx, snapshot.vy, snapshot.vz);
    this.player.onGround = (snapshot.flags & SNAPSHOT_FLAG.ON_GROUND) !== 0;
    this.player.ducking = (snapshot.flags & SNAPSHOT_FLAG.DUCKING) !== 0;
    // El progreso viene del servidor tal cual: deducirlo del bit `DUCKING`
    // saltaba a 0 o a 1 y movia la camara 18 unidades de golpe en mitad de
    // cualquier correccion, que es de donde salia el temblor al agacharse.
    this.player.duckProgress = snapshot.duck;
    this.player.health = snapshot.health;
    this.player.alive = (snapshot.flags & SNAPSHOT_FLAG.ALIVE) !== 0;
    this.player.weapon = snapshot.weapon;
    this.player.ammo[snapshot.weapon] = snapshot.ammo;
  }

  /** Reinicia la prediccion tras un respawn o un cambio de ronda. */
  reset(snapshot: PlayerSnapshot): void {
    this.adoptServerState(snapshot);
    this.player.vel = vec3();
    this.pending = [];
    this.lastCorrection = 0;
  }
}
