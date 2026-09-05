/**
 * Bot de practica.
 *
 * No es un jugador artificial "justo": no hace prediccion ni reconciliacion,
 * porque vive dentro del servidor. Genera comandos de usuario igual que un
 * cliente humano, asi que pasa por la misma fisica, el mismo hitscan y las
 * mismas reglas de arma. Su unica ventaja es no tener latencia, y se compensa
 * con un error de punteria y un tiempo de reaccion explicitos.
 *
 * Se mueve por el grafo de navegacion del mapa (ver `navigation.ts`), asi que
 * funciona igual en una arena abierta que en un mapa de pasillos. Apunta al
 * rival mientras camina hacia otro sitio, como un jugador: el rumbo se traduce
 * a las teclas de movimiento relativas a donde esta mirando.
 */

import {
  BUTTON,
  type CollisionWorld,
  type GameMap,
  MAX_PITCH,
  type NavGraph,
  type PlayerState,
  TICK_DT,
  type UserCommand,
  type Vec3,
  angleDelta,
  clamp,
  createCollisionWorld,
  createRandom,
  eyePosition,
  findPath,
  getWeapon,
  hasLineOfSight,
  length2D,
  navGraphOf,
  normalizeAngle,
  radToDeg,
  vec3,
} from '@neonduel/shared';

export interface BotDifficulty {
  /** Grados por segundo a los que corrige la punteria. */
  turnSpeed: number;
  /** Error angular maximo al apuntar, en grados. */
  aimError: number;
  /** Segundos que tarda en reaccionar al ver al rival. */
  reactionTime: number;
  /** Balas por rafaga antes de soltar el gatillo. */
  burstLength: number;
  /** Fraccion del retroceso que sabe compensar. */
  recoilControl: number;
}

export const BOT_DIFFICULTIES: Record<'easy' | 'normal' | 'hard', BotDifficulty> = {
  easy: {
    turnSpeed: 180,
    aimError: 5,
    reactionTime: 0.45,
    burstLength: 5,
    recoilControl: 0.2,
  },
  normal: {
    turnSpeed: 320,
    aimError: 2.4,
    reactionTime: 0.25,
    burstLength: 7,
    recoilControl: 0.55,
  },
  hard: {
    turnSpeed: 520,
    aimError: 1.1,
    reactionTime: 0.14,
    burstLength: 10,
    recoilControl: 0.85,
  },
};

/** Cada cuanto se comprueba si el bot esta progresando hacia su objetivo. */
/** Unidades que debe acortar en ese intervalo para no considerarse atascado. */
const MIN_PROGRESS_UNITS = 60;

/** Cuanto tiene que moverse el objetivo para rehacer el camino. */
const REPATH_DISTANCE = 160;

/** Y cada cuanto se rehace de todos modos, por si el mapa cambio de mano. */
const REPATH_SECONDS = 0.5;

/**
 * Radio para dar un waypoint por alcanzado. Menor que la separacion del grafo
 * (32): con un radio mayor el bot corta camino entre nodos y se va desviando
 * del pasillo, que es como acaba encajado en el costado de una escalera.
 */
const WAYPOINT_RADIUS = 22;

/** Sin acercarse al waypoint durante este tiempo, se da por atascado. */
const STUCK_SECONDS = 1;

/**
 * Traduce una direccion del mundo a los botones que la producen mirando a
 * `yaw`. El umbral evita que una desviacion minima haga pulsar dos teclas y el
 * bot avance en diagonal cuando queria ir recto.
 */
export const movementButtons = (yawDeg: number, dx: number, dy: number): number => {
  const yaw = (yawDeg * Math.PI) / 180;
  const adelante = dx * Math.cos(yaw) + dy * Math.sin(yaw);
  const derecha = dx * Math.sin(yaw) - dy * Math.cos(yaw);

  let buttons = 0;
  if (adelante > MOVE_THRESHOLD) buttons |= BUTTON.FORWARD;
  else if (adelante < -MOVE_THRESHOLD) buttons |= BUTTON.BACK;
  if (derecha > MOVE_THRESHOLD) buttons |= BUTTON.RIGHT;
  else if (derecha < -MOVE_THRESHOLD) buttons |= BUTTON.LEFT;
  return buttons;
};

const MOVE_THRESHOLD = 0.25;
/** Duracion de un rodeo lateral. */

export class BotController {
  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private visibleFor = 0;
  private burstShots = 0;
  private burstCooldown = 0;
  private strafeDirection: 1 | -1 = 1;
  private strafeTimer = 0;
  /** Distancia al rival en la ultima revision de progreso. */
  private readonly random: () => number;
  private readonly world: CollisionWorld;
  private readonly nav: NavGraph;
  /** Camino pendiente hacia el objetivo, en orden. */
  private path: Vec3[] = [];
  /** Punto para el que se calculo `path`: si el rival se mueve, se rehace. */
  private pathTarget: Vec3 | null = null;
  private repathTimer = 0;
  /** Distancia al waypoint en la ultima revision, para detectar atascos. */
  private waypointDistance = Infinity;
  private stuckTimer = 0;

  constructor(
    readonly connectionId: number,
    map: GameMap,
    private readonly difficulty: BotDifficulty = BOT_DIFFICULTIES.normal,
    seed = 0xb07,
  ) {
    this.random = createRandom(seed);
    this.world = createCollisionWorld(map);
    this.nav = navGraphOf(map);
  }

  /** Genera el comando de este tick a partir del estado del mundo. */
  think(self: PlayerState, enemy: PlayerState | undefined, frozen: boolean): UserCommand {
    this.seq += 1;
    this.yaw = self.yaw;
    this.pitch = self.pitch;

    if (!self.alive || !enemy || !enemy.alive || frozen) {
      this.visibleFor = 0;
      this.burstShots = 0;
      return this.command(0);
    }

    const eye = eyePosition(self);
    const targetPoint = this.aimPoint(enemy);
    const visible = hasLineOfSight(this.world, eye, targetPoint);

    this.visibleFor = visible ? this.visibleFor + TICK_DT : 0;
    this.aimAt(eye, targetPoint, visible, self);

    let buttons = this.movement(self, enemy, visible);
    buttons |= this.shooting(self, visible);
    return this.command(buttons);
  }

  /** Punto al que apunta: el pecho, con una ligera preferencia por la cabeza. */
  private aimPoint(enemy: PlayerState): Vec3 {
    const height = enemy.ducking ? 54 : 72;
    const target = this.difficulty.aimError < 2 ? 0.85 : 0.6;
    return vec3(enemy.pos.x, enemy.pos.y, enemy.pos.z + height * target);
  }

  private aimAt(eye: Vec3, target: Vec3, visible: boolean, self: PlayerState): void {
    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;
    const horizontal = Math.hypot(dx, dy);

    const desiredYaw = radToDeg(Math.atan2(dy, dx));
    const desiredPitch = radToDeg(-Math.atan2(dz, horizontal));

    // Ruido estable por tick: temblor de punteria, no un salto aleatorio.
    const error = visible ? this.difficulty.aimError : this.difficulty.aimError * 2;
    const jitterYaw = (this.random() - 0.5) * error;
    const jitterPitch = (this.random() - 0.5) * error * 0.5;

    // Compensacion parcial del retroceso: baja la mira mientras dispara.
    const weapon = getWeapon(self.weapon);
    const recoil = weapon.recoilPattern[
      Math.min(self.shotIndex, weapon.recoilPattern.length - 1)
    ] ?? [0, 0];
    const compensation = recoil[1] * this.difficulty.recoilControl;

    const maxTurn = this.difficulty.turnSpeed * TICK_DT;
    const yawDelta = clamp(
      angleDelta(this.yaw, desiredYaw + jitterYaw),
      -maxTurn,
      maxTurn,
    );
    const pitchDelta = clamp(
      desiredPitch + jitterPitch + compensation - this.pitch,
      -maxTurn,
      maxTurn,
    );

    this.yaw = normalizeAngle(this.yaw + yawDelta);
    this.pitch = clamp(this.pitch + pitchDelta, -MAX_PITCH, MAX_PITCH);
  }

  private movement(self: PlayerState, enemy: PlayerState, visible: boolean): number {
    let buttons = 0;

    const distance = Math.hypot(enemy.pos.x - self.pos.x, enemy.pos.y - self.pos.y);

    this.strafeTimer -= TICK_DT;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.4 + this.random() * 0.8;
      this.strafeDirection = this.random() < 0.5 ? 1 : -1;
    }

    if (visible && distance < 700) {
      // A tiro: mantener la distancia y moverse en lateral para ser dificil.

      buttons |= this.strafeDirection > 0 ? BUTTON.RIGHT : BUTTON.LEFT;
      if (distance < 250) buttons |= BUTTON.BACK;
      // Parar en seco antes de disparar: moverse arruina la precision.
      if (this.visibleFor > this.difficulty.reactionTime && length2D(self.vel) > 90) {
        buttons = this.counterStrafe(buttons);
      }
      return buttons;
    }

    // Fuera de combate se va al rival por el camino que da la navegacion, no
    // en linea recta: en un mapa de pasillos la linea recta es una pared.
    return buttons | this.navigateTo(self, enemy.pos);
  }

  /**
   * Avanza por el camino hacia `target` y devuelve los botones de movimiento.
   *
   * El rumbo no es la mirada: el bot apunta al rival mientras camina hacia otro
   * lado, igual que un jugador, asi que la direccion se traduce a adelante,
   * atras e izquierda/derecha respecto a donde esta mirando.
   *
   * Es publico a proposito: es la costura por la que los tests comprueban que
   * llega a un punto cualquiera sin tener que montar una partida entera.
   */
  navigateTo(self: PlayerState, target: Vec3): number {
    this.repathTimer -= TICK_DT;
    const objetivoMovido =
      !this.pathTarget ||
      Math.hypot(target.x - this.pathTarget.x, target.y - this.pathTarget.y) > REPATH_DISTANCE;

    if (this.path.length === 0 || objetivoMovido || this.repathTimer <= 0) {
      this.path = findPath(this.nav, self.pos, target);
      this.pathTarget = { ...target };
      this.repathTimer = REPATH_SECONDS;
      this.waypointDistance = Infinity;
      this.stuckTimer = 0;
      // El primer nodo suele ser el suelo bajo los pies: ir a el es no ir.
      if (this.path.length > 1) this.path.shift();
    }

    const waypoint = this.path[0];
    if (!waypoint) return BUTTON.FORWARD;

    const dx = waypoint.x - self.pos.x;
    const dy = waypoint.y - self.pos.y;
    const distancia = Math.hypot(dx, dy);
    if (distancia < WAYPOINT_RADIUS) {
      this.path.shift();
      this.waypointDistance = Infinity;
      this.stuckTimer = 0;
      return this.navigateTo(self, target);
    }

    // Atasco: si en un segundo no se ha acercado al waypoint, es que hay algo
    // en medio que el grafo no ve (el rival, sin ir mas lejos). Se salta ese
    // punto en vez de empujar contra el.
    this.stuckTimer += TICK_DT;
    let extra = 0;
    if (this.stuckTimer >= STUCK_SECONDS) {
      if (distancia > this.waypointDistance - MIN_PROGRESS_UNITS) {
        // Enganchado. Saltar resuelve el caso mas comun, quedarse trabado en el
        // canto de un escalon, y rehacer el camino resuelve el resto.
        extra = BUTTON.JUMP;
        this.repathTimer = 0;
      }
      this.waypointDistance = distancia;
      this.stuckTimer = 0;
    }

    return movementButtons(this.yaw, dx / distancia, dy / distancia) | extra;
  }

  /** Invierte la direccion pulsada para frenar de golpe, como un jugador. */
  private counterStrafe(buttons: number): number {
    let result = buttons;
    if (result & BUTTON.RIGHT) result = (result & ~BUTTON.RIGHT) | BUTTON.LEFT;
    else if (result & BUTTON.LEFT) result = (result & ~BUTTON.LEFT) | BUTTON.RIGHT;
    if (result & BUTTON.FORWARD) result = (result & ~BUTTON.FORWARD) | BUTTON.BACK;
    return result;
  }

  private shooting(self: PlayerState, visible: boolean): number {
    if (self.ammo[self.weapon] === 0) return BUTTON.RELOAD;

    this.burstCooldown = Math.max(0, this.burstCooldown - TICK_DT);
    if (!visible || this.visibleFor < this.difficulty.reactionTime) {
      this.burstShots = 0;
      return 0;
    }
    if (this.burstCooldown > 0) return 0;

    this.burstShots += 1;
    if (this.burstShots >= this.difficulty.burstLength) {
      this.burstShots = 0;
      // Pausa entre rafagas: deja que el patron de retroceso se reinicie.
      this.burstCooldown = 0.4 + this.random() * 0.3;
      return 0;
    }
    return BUTTON.ATTACK;
  }

  private command(buttons: number): UserCommand {
    return {
      seq: this.seq,
      buttons,
      yaw: this.yaw,
      pitch: this.pitch,
      dt: TICK_DT,
    };
  }
}
