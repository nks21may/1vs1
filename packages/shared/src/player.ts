/**
 * Estado del jugador y avance de un tick de simulacion.
 *
 * Todos los temporizadores (cadencia, recarga, reinicio del patron de
 * retroceso) se guardan como *tiempo restante* y avanzan con el `dt` del
 * comando, nunca con un reloj absoluto. Asi el cliente puede reproducir N
 * comandos durante la reconciliacion y obtener exactamente el mismo estado que
 * el servidor, sin necesidad de sincronizar relojes.
 */

import { BUTTON, MAX_HEALTH, hasButton } from './constants.js';
import type { CollisionWorld } from './collision.js';
import { type Vec3, clone, length2D, vec3 } from './math.js';
import {
  type MoveEvents,
  type MoveState,
  type UserCommand,
  eyePosition,
  maxSpeedFor,
  moveStep,
} from './movement.js';
import {
  type WeaponId,
  computeShotAngles,
  computeSpread,
  getWeapon,
  weaponForSlot,
  weaponSpeedMultiplier,
  shotSeed,
} from './weapons.js';

export interface PlayerState extends MoveState {
  readonly id: number;
  name: string;
  health: number;
  alive: boolean;
  weapon: WeaponId;
  /** Balas en el cargador de cada arma. La reserva es infinita. */
  ammo: Record<WeaponId, number>;
  /** Segundos que faltan para poder disparar de nuevo. */
  fireCooldown: number;
  /** Segundos que faltan para terminar la recarga (0 = no recargando). */
  reloadRemaining: number;
  /** Indice dentro del patron de retroceso. */
  shotIndex: number;
  /** Segundos desde el ultimo disparo; al superar el umbral reinicia el patron. */
  timeSinceShot: number;
  /** Numero total de disparos: alimenta la semilla determinista de dispersion. */
  shotCounter: number;
  /** True mientras el boton de disparo siga pulsado (armas semiautomaticas). */
  attackHeld: boolean;
  /**
   * True mientras el jugador esta apuntando con mira. Es estado simulado y no
   * un adorno del cliente: de el dependen la velocidad y la dispersion, asi que
   * el servidor tiene que llevarlo el mismo para poder validar los disparos.
   */
  aiming: boolean;
}

/** Disparo generado por la simulacion; el servidor lo resuelve con hitscan. */
export interface ShotRequest {
  origin: Vec3;
  yaw: number;
  pitch: number;
  weapon: WeaponId;
  shotIndex: number;
  seed: number;
}

export interface PlayerTickEvents extends MoveEvents {
  shot: ShotRequest | null;
  startedReload: boolean;
  finishedReload: boolean;
  switchedWeapon: boolean;
  emptyClick: boolean;
}

/**
 * Cargadores llenos al empezar la ronda. El cuchillo entra con un cero que
 * nadie lee: al ser cuerpo a cuerpo, ni gasta ni recarga.
 */
const fullMagazines = (): Record<WeaponId, number> => ({
  rifle: getWeapon('rifle').magazine,
  pistol: getWeapon('pistol').magazine,
  knife: 0,
  sniper: getWeapon('sniper').magazine,
});

export const createPlayer = (id: number, name: string, pos: Vec3, yaw = 0): PlayerState => ({
  id,
  name,
  pos: clone(pos),
  vel: vec3(),
  yaw,
  pitch: 0,
  onGround: false,
  ducking: false,
  duckProgress: 0,
  jumpHeld: false,
  timeSinceLanding: 0,
  health: MAX_HEALTH,
  alive: true,
  weapon: 'rifle',
  ammo: fullMagazines(),
  fireCooldown: 0,
  reloadRemaining: 0,
  shotIndex: 0,
  timeSinceShot: 999,
  shotCounter: 0,
  attackHeld: false,
  aiming: false,
});

/** Devuelve al jugador al estado inicial de ronda en el punto indicado. */
export const respawnPlayer = (player: PlayerState, pos: Vec3, yaw: number): void => {
  player.pos = clone(pos);
  player.vel = vec3();
  player.yaw = yaw;
  player.pitch = 0;
  player.onGround = false;
  player.ducking = false;
  player.duckProgress = 0;
  player.jumpHeld = false;
  player.timeSinceLanding = 0;
  player.health = MAX_HEALTH;
  player.alive = true;
  player.weapon = 'rifle';
  player.ammo = fullMagazines();
  player.fireCooldown = 0;
  player.reloadRemaining = 0;
  player.shotIndex = 0;
  player.timeSinceShot = 999;
  player.attackHeld = false;
  player.aiming = false;
};

const emptyEvents = (): PlayerTickEvents => ({
  jumped: false,
  landed: false,
  landingSpeed: 0,
  bhop: false,
  shot: null,
  startedReload: false,
  finishedReload: false,
  switchedWeapon: false,
  emptyClick: false,
});

/** True si el arma puede disparar ahora mismo. */
export const canFire = (player: PlayerState): boolean =>
  player.alive &&
  player.fireCooldown <= 0 &&
  player.reloadRemaining <= 0 &&
  (getWeapon(player.weapon).melee || player.ammo[player.weapon] > 0);

const startReload = (player: PlayerState): boolean => {
  const weapon = getWeapon(player.weapon);
  if (player.reloadRemaining > 0) return false;
  if (player.ammo[player.weapon] >= weapon.magazine) return false;
  player.reloadRemaining = weapon.reloadTime;
  return true;
};

/**
 * Avanza un tick completo del jugador: temporizadores, cambio de arma, recarga,
 * disparo y movimiento. Muta `player` y devuelve lo que ha ocurrido.
 */
export const simulatePlayerTick = (
  player: PlayerState,
  cmd: UserCommand,
  world: CollisionWorld,
): PlayerTickEvents => {
  const events = emptyEvents();
  const dt = cmd.dt;

  if (!player.alive) {
    // Los muertos solo actualizan la vista (camara de muerte).
    player.yaw = cmd.yaw;
    player.pitch = cmd.pitch;
    return events;
  }

  // --- Temporizadores ---
  player.fireCooldown = Math.max(0, player.fireCooldown - dt);
  player.timeSinceShot += dt;

  const weaponBefore = getWeapon(player.weapon);
  if (player.timeSinceShot > weaponBefore.recoilResetTime) player.shotIndex = 0;

  if (player.reloadRemaining > 0) {
    player.reloadRemaining = Math.max(0, player.reloadRemaining - dt);
    if (player.reloadRemaining === 0) {
      player.ammo[player.weapon] = weaponBefore.magazine;
      events.finishedReload = true;
    }
  }

  // --- Cambio de arma ---
  // Una ranura por arma, y la peticion es idempotente: pedir el arma que ya se
  // lleva no hace nada, asi que mantener la tecla pulsada no encadena cambios y
  // no hace falta detectar el flanco de la pulsacion.
  const requested = cmd.slot ? weaponForSlot(cmd.slot) : null;
  if (requested !== null && requested !== player.weapon) {
    player.weapon = requested;
    player.reloadRemaining = 0;
    player.shotIndex = 0;
    player.fireCooldown = Math.max(player.fireCooldown, 0.25);
    events.switchedWeapon = true;
  }

  const weapon = getWeapon(player.weapon);

  // --- Apuntado ---
  // Se resuelve antes de mover y de disparar porque los dos dependen de el.
  // Cambiar a un arma sin mira lo cancela solo, al no haber perfil de mira.
  player.aiming = weapon.aim !== null && hasButton(cmd.buttons, BUTTON.AIM);

  // --- Recarga manual ---
  if (hasButton(cmd.buttons, BUTTON.RELOAD) && startReload(player)) {
    events.startedReload = true;
  }

  // --- Disparo ---
  const attackPressed = hasButton(cmd.buttons, BUTTON.ATTACK);
  const triggerPulled =
    weapon.mode === 'auto' ? attackPressed : attackPressed && !player.attackHeld;

  if (triggerPulled) {
    if (canFire(player)) {
      const maxSpeed = maxSpeedFor(
        cmd.buttons,
        player.ducking,
        weaponSpeedMultiplier(weapon, player.aiming),
      );
      const spread = computeSpread(
        weapon,
        {
          speed: length2D(player.vel),
          onGround: player.onGround,
          ducking: player.ducking,
          aiming: player.aiming,
        },
        maxSpeed,
      );
      const seed = shotSeed(player.id, player.shotCounter);
      const angles = computeShotAngles(
        weapon,
        { yaw: cmd.yaw, pitch: cmd.pitch },
        player.shotIndex,
        spread,
        seed,
      );

      events.shot = {
        origin: eyePosition(player),
        yaw: angles.yaw,
        pitch: angles.pitch,
        weapon: player.weapon,
        shotIndex: player.shotIndex,
        seed,
      };

      if (!weapon.melee) player.ammo[player.weapon] -= 1;
      player.fireCooldown = weapon.cycleTime;
      player.shotIndex += 1;
      player.shotCounter += 1;
      player.timeSinceShot = 0;
    } else if (
      !weapon.melee &&
      player.ammo[player.weapon] === 0 &&
      player.reloadRemaining === 0 &&
      player.fireCooldown <= 0
    ) {
      events.emptyClick = true;
      // Recarga automatica al quedarse sin balas, como en CS.
      if (startReload(player)) events.startedReload = true;
    }
  }
  player.attackHeld = attackPressed;

  // --- Movimiento ---
  const moveEvents = moveStep(player, cmd, world, weaponSpeedMultiplier(weapon, player.aiming));
  events.jumped = moveEvents.jumped;
  events.landed = moveEvents.landed;
  events.landingSpeed = moveEvents.landingSpeed;
  events.bhop = moveEvents.bhop;

  return events;
};

/**
 * Recorta un comando durante las fases congeladas: el jugador puede mirar
 * alrededor pero no moverse, saltar ni disparar.
 *
 * Vive en el paquete compartido a proposito: si el servidor filtrase y el
 * cliente no, la prediccion divergiria en cada ronda y el jugador veria un
 * tiron al empezar.
 */
export const applyPhaseRestrictions = (cmd: UserCommand, frozen: boolean): UserCommand => {
  if (!frozen) return cmd;
  // Solo sobreviven las teclas que no alteran la posicion ni el estado del arma.
  return { ...cmd, buttons: cmd.buttons & BUTTON.DUCK, slot: 0 };
};

/** Aplica dano y devuelve true si el golpe fue letal. */
export const applyDamage = (player: PlayerState, damage: number): boolean => {
  if (!player.alive) return false;
  player.health -= damage;
  if (player.health <= 0) {
    player.health = 0;
    player.alive = false;
    return true;
  }
  return false;
};
