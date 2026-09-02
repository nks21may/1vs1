/**
 * Bot de practica.
 *
 * No es un jugador artificial "justo": no hace prediccion ni reconciliacion,
 * porque vive dentro del servidor. Genera comandos de usuario igual que un
 * cliente humano, asi que pasa por la misma fisica, el mismo hitscan y las
 * mismas reglas de arma. Su unica ventaja es no tener latencia, y se compensa
 * con un error de punteria y un tiempo de reaccion explicitos.
 *
 * La navegacion es deliberadamente simple (ir hacia el rival y desatascarse):
 * el mapa es una arena abierta y un navmesh completo no aportaria nada aqui.
 */

import {
  BUTTON,
  type CollisionWorld,
  MAX_PITCH,
  type PlayerState,
  TICK_DT,
  type UserCommand,
  type Vec3,
  angleDelta,
  clamp,
  createRandom,
  eyePosition,
  getWeapon,
  hasLineOfSight,
  length2D,
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
const PROGRESS_CHECK_SECONDS = 1;
/** Unidades que debe acortar en ese intervalo para no considerarse atascado. */
const MIN_PROGRESS_UNITS = 60;
/** Duracion de un rodeo lateral. */
const AVOID_SECONDS = 1.4;

export class BotController {
  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private visibleFor = 0;
  private burstShots = 0;
  private burstCooldown = 0;
  private strafeDirection: 1 | -1 = 1;
  private strafeTimer = 0;
  private avoidTimer = 0;
  private avoidDirection: 1 | -1 = 1;
  private failedAvoids = 0;
  /** Distancia al rival en la ultima revision de progreso. */
  private referenceDistance = Infinity;
  private progressTimer = 0;
  private readonly random: () => number;

  constructor(
    readonly connectionId: number,
    private readonly world: CollisionWorld,
    private readonly difficulty: BotDifficulty = BOT_DIFFICULTIES.normal,
    seed = 0xb07,
  ) {
    this.random = createRandom(seed);
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
      this.avoidTimer = 0;
      this.progressTimer = 0;
      this.referenceDistance = distance;

      buttons |= this.strafeDirection > 0 ? BUTTON.RIGHT : BUTTON.LEFT;
      if (distance < 250) buttons |= BUTTON.BACK;
      // Parar en seco antes de disparar: moverse arruina la precision.
      if (this.visibleFor > this.difficulty.reactionTime && length2D(self.vel) > 90) {
        buttons = this.counterStrafe(buttons);
      }
      return buttons;
    }

    if (this.avoidTimer > 0) {
      // Rodeo en curso: strafe puro y sostenido. Anadir "adelante" empujaria
      // contra el obstaculo, y saltar quitaria el control que da el suelo.
      this.avoidTimer -= TICK_DT;
      buttons |= this.avoidDirection > 0 ? BUTTON.RIGHT : BUTTON.LEFT;
      return buttons;
    }

    // Revision periodica de progreso: lo que importa no es haberse movido, sino
    // haber *acortado* distancia. Deslizar pegado a una caja se mueve mucho y
    // no acerca nada, y es justo el caso que hay que detectar.
    this.progressTimer += TICK_DT;
    if (this.progressTimer >= PROGRESS_CHECK_SECONDS) {
      const gained = this.referenceDistance - distance;
      if (gained < MIN_PROGRESS_UNITS) {
        this.avoidTimer = AVOID_SECONDS;
        this.failedAvoids += 1;
        // Si rodear por un lado no funciona dos veces seguidas, se prueba el otro.
        if (this.failedAvoids >= 2) {
          this.avoidDirection = this.avoidDirection > 0 ? -1 : 1;
          this.failedAvoids = 0;
        }
      } else {
        this.failedAvoids = 0;
      }
      this.referenceDistance = distance;
      this.progressTimer = 0;
    }

    buttons |= BUTTON.FORWARD;
    if (this.random() < 0.02) {
      buttons |= this.strafeDirection > 0 ? BUTTON.RIGHT : BUTTON.LEFT;
    }
    return buttons;
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
