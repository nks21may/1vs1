/**
 * Constantes de la simulacion.
 *
 * Las unidades son "unidades de motor" al estilo Source (1 unidad ~= 1.9 cm),
 * porque los valores de movimiento de CS2 estan calibrados en esa escala y
 * copiarlos tal cual es lo que reproduce la sensacion de juego.
 */

/** Frecuencia de simulacion. Cliente y servidor avanzan con este paso fijo. */
export const TICK_RATE = 64;
export const TICK_INTERVAL_MS = 1000 / TICK_RATE;
export const TICK_DT = 1 / TICK_RATE;

// --- Fisica de movimiento (equivalentes a los cvars de Source) ---
export const GRAVITY = 800;
export const MAX_SPEED = 250;
/** Multiplicadores de velocidad segun el arma equipada (como en CS). */
export const FRICTION = 5.2;
export const STOP_SPEED = 80;
export const ACCELERATE = 5.5;
export const AIR_ACCELERATE = 12;
/** Tope de `wishspeed` en el aire: la clave del air-strafing de Source. */
export const AIR_MAX_WISH_SPEED = 30;
/** Impulso vertical del salto: sqrt(2 * GRAVITY * 57) ~= 301.99 unidades/s. */
export const JUMP_IMPULSE = 301.993;
/** Altura maxima de escalon que se sube sin saltar. */
export const STEP_SIZE = 18;
/** Coseno maximo para considerar una superficie "suelo" (45 grados). */
export const MAX_GROUND_NORMAL_Z = 0.7;
/** Penalizacion de velocidad al aterrizar tras una caida fuerte. */
export const LAND_SPEED_PENALTY = 0.85;
export const LAND_PENALTY_MIN_FALL_SPEED = 580;

// --- Dimensiones del jugador (origen en los pies) ---
export const PLAYER_HALF_WIDTH = 16;
export const PLAYER_HEIGHT_STANDING = 72;
export const PLAYER_HEIGHT_DUCKED = 54;
export const EYE_HEIGHT_STANDING = 64;
export const EYE_HEIGHT_DUCKED = 46;
/** Tiempo que tarda la transicion de agachado (segundos). */
export const DUCK_TRANSITION_TIME = 0.2;
export const DUCK_SPEED_MULTIPLIER = 0.34;
export const WALK_SPEED_MULTIPLIER = 0.52;

/**
 * Velocidad a partir de la cual un jugador hace ruido al pisar. Se define desde
 * el multiplicador de andar y no como un numero suelto: andar tiene que ser
 * silencioso siempre, asi que si algun dia se retoca lo que corre alguien
 * andando, el umbral lo sigue solo. El 8% de margen es para que rozar el tope
 * andando no delate.
 */
export const FOOTSTEP_MIN_SPEED = MAX_SPEED * WALK_SPEED_MULTIPLIER * 1.08;

/**
 * Distancia entre dos pisadas. Contar distancia y no tiempo hace que la
 * cadencia salga sola: cuanto mas rapido va alguien, mas seguidos suenan sus
 * pasos, sin ninguna formula aparte.
 */
export const FOOTSTEP_STRIDE = 84;

// --- Hitboxes (fracciones de la altura actual del jugador) ---
export const HEAD_HITBOX_BOTTOM = 0.82;
export const LEGS_HITBOX_TOP = 0.42;
export const HITBOX_HALF_WIDTH = 17;

// --- Combate ---
export const MAX_HEALTH = 100;
export const MAX_PITCH = 89;

// --- Reglas de partida ---
export const ROUNDS_TO_WIN = 8;
export const WARMUP_SECONDS = 3;
export const ROUND_TIME_SECONDS = 90;
export const ROUND_END_SECONDS = 3;
export const FREEZE_TIME_SECONDS = 2;
export const MATCH_END_SECONDS = 12;

// --- Red ---
/** Retardo de interpolacion del cliente para las entidades remotas. */
export const INTERP_DELAY_MS = 100;
/** Ventana maxima que el servidor rebobina al compensar latencia. */
export const MAX_REWIND_MS = 200;
/** Historial de estados que guarda el servidor para la compensacion. */
export const LAG_COMPENSATION_HISTORY_TICKS = 32;
/** Comandos de entrada maximos que se aceptan por paquete (anti flood). */
export const MAX_COMMANDS_PER_PACKET = 16;
/** Comandos maximos que el servidor procesa por tick de un mismo cliente. */
export const MAX_COMMANDS_PER_TICK = 8;
/** Buffer de comandos por jugador antes de descartar los mas antiguos. */
export const INPUT_BUFFER_SIZE = 64;

// --- Botones del comando de usuario (bitmask) ---
export const BUTTON = {
  FORWARD: 1 << 0,
  BACK: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
  JUMP: 1 << 4,
  DUCK: 1 << 5,
  ATTACK: 1 << 6,
  RELOAD: 1 << 7,
  WALK: 1 << 8,
  SWITCH: 1 << 9,
} as const;

export type ButtonMask = number;

export const hasButton = (buttons: ButtonMask, button: number): boolean =>
  (buttons & button) !== 0;
