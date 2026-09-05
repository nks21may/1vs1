/**
 * Movimiento del jugador al estilo Source/CS2.
 *
 * Reimplementa la cadena `PM_PlayerMove` de Valve: friccion, aceleracion
 * limitada por proyeccion, tope de `wishspeed` en el aire (de ahi salen el
 * air-strafing y el bhop), salto con ventana de encadenado y subida de
 * escalones. La funcion es pura respecto al mundo y avanza con un paso fijo,
 * de modo que el mismo comando produce el mismo resultado en cliente y
 * servidor: es el requisito para la prediccion con reconciliacion.
 */

import {
  ACCELERATE,
  AIR_ACCELERATE,
  AIR_MAX_WISH_SPEED,
  BHOP_CUE_MAX_DROP,
  BHOP_SPEED_RATIO,
  BHOP_WINDOW,
  BUTTON,
  DUCK_SPEED_MULTIPLIER,
  DUCK_TRANSITION_TIME,
  EYE_HEIGHT_DUCKED,
  EYE_HEIGHT_STANDING,
  FOOTSTEP_MIN_SPEED,
  FOOTSTEP_STRIDE,
  FRICTION,
  GRAVITY,
  JUMP_IMPULSE,
  JUMP_SPEED_CAP,
  LAND_PENALTY_MIN_FALL_SPEED,
  LAND_SPEED_PENALTY,
  MAX_GROUND_NORMAL_Z,
  MAX_SPEED,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT_DUCKED,
  PLAYER_HEIGHT_STANDING,
  STEP_SIZE,
  STOP_SPEED,
  WALK_SPEED_MULTIPLIER,
  hasButton,
} from './constants.js';
import {
  DIST_EPSILON,
  type CollisionWorld,
  clipVelocity,
  isPositionSolid,
  traceBox,
} from './collision.js';
import {
  type Vec3,
  angleVectors,
  clamp,
  clone,
  copy,
  lerp,
  length2D,
  normalizeInPlace,
  scale,
  vec3,
} from './math.js';

/** Estado minimo que necesita el motor de movimiento. */
export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  ducking: boolean;
  /** 0 = de pie, 1 = totalmente agachado. Afecta a la vista y al hitbox. */
  duckProgress: number;
  /** Impide el auto-bhop: hay que soltar salto entre brincos. */
  jumpHeld: boolean;
  /**
   * Segundos apoyado en el suelo desde el ultimo aterrizaje. Es lo que mide si
   * un salto entra en la ventana de bhop.
   */
  timeSinceLanding: number;
}

/** Comando de entrada de un tick. */
export interface UserCommand {
  /** Numero de secuencia monotono, usado para la reconciliacion. */
  seq: number;
  buttons: number;
  yaw: number;
  pitch: number;
  /** Paso de tiempo del comando en segundos (fijo, validado por el servidor). */
  dt: number;
  /**
   * Ranura de arma que se pide en este tick (1-based), o 0/ausente si no se pide
   * ninguna. Va como numero y no como bits de `buttons` porque lo que el jugador
   * expresa es "quiero *esta* arma", no "pulso una tecla": asi la peticion es
   * idempotente y mantener la tecla no encadena cambios.
   */
  slot?: number;
}

/** Eventos observables del movimiento, utiles para sonido y animacion. */
export interface MoveEvents {
  jumped: boolean;
  landed: boolean;
  landingSpeed: number;
  /**
   * El salto salio dentro de la ventana de bhop y a velocidad de carrera: es la
   * senal que el cliente convierte en confirmacion sonora.
   */
  bhop: boolean;
}

export const playerMins = (): Vec3 => vec3(-PLAYER_HALF_WIDTH, -PLAYER_HALF_WIDTH, 0);

export const playerMaxs = (ducking: boolean): Vec3 =>
  vec3(
    PLAYER_HALF_WIDTH,
    PLAYER_HALF_WIDTH,
    ducking ? PLAYER_HEIGHT_DUCKED : PLAYER_HEIGHT_STANDING,
  );

export const playerHeight = (ducking: boolean): number =>
  ducking ? PLAYER_HEIGHT_DUCKED : PLAYER_HEIGHT_STANDING;

/** Altura de los ojos interpolada segun la transicion de agachado. */
export const eyeHeight = (duckProgress: number): number =>
  lerp(EYE_HEIGHT_STANDING, EYE_HEIGHT_DUCKED, clamp(duckProgress, 0, 1));

export const eyePosition = (state: MoveState): Vec3 =>
  vec3(state.pos.x, state.pos.y, state.pos.z + eyeHeight(state.duckProgress));

/**
 * Friccion del suelo. Reduce la velocidad de forma proporcional salvo por debajo
 * de `STOP_SPEED`, donde el frenado es constante: eso es lo que hace que el
 * counter-strafing detenga al jugador casi en seco.
 */
export const applyFriction = (vel: Vec3, dt: number, surfaceFriction = 1): void => {
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (speed < 0.1) return;
  const control = speed < STOP_SPEED ? STOP_SPEED : speed;
  const drop = control * FRICTION * surfaceFriction * dt;
  const newSpeed = Math.max(0, speed - drop) / speed;
  vel.x *= newSpeed;
  vel.y *= newSpeed;
  vel.z *= newSpeed;
};

/**
 * Aceleracion de Quake: solo se anade velocidad en la componente que aun falta
 * para alcanzar `wishSpeed` en la direccion deseada. Como el limite se aplica a
 * la *proyeccion* y no al modulo, girar el raton mientras se pulsa un lateral
 * permite superar la velocidad maxima (air-strafing).
 */
export const accelerate = (
  vel: Vec3,
  wishDir: Vec3,
  wishSpeed: number,
  accel: number,
  dt: number,
  surfaceFriction = 1,
): void => {
  const currentSpeed = vel.x * wishDir.x + vel.y * wishDir.y + vel.z * wishDir.z;
  const addSpeed = wishSpeed - currentSpeed;
  if (addSpeed <= 0) return;

  let accelSpeed = accel * wishSpeed * dt * surfaceFriction;
  if (accelSpeed > addSpeed) accelSpeed = addSpeed;

  vel.x += accelSpeed * wishDir.x;
  vel.y += accelSpeed * wishDir.y;
  vel.z += accelSpeed * wishDir.z;
};

/** Aceleracion en el aire: el `wishSpeed` efectivo se limita a 30 u/s. */
export const airAccelerate = (vel: Vec3, wishDir: Vec3, wishSpeed: number, dt: number): void => {
  const cappedWish = Math.min(wishSpeed, AIR_MAX_WISH_SPEED);
  const currentSpeed = vel.x * wishDir.x + vel.y * wishDir.y + vel.z * wishDir.z;
  const addSpeed = cappedWish - currentSpeed;
  if (addSpeed <= 0) return;

  // El termino de aceleracion usa el wishSpeed sin recortar, como en Source.
  let accelSpeed = AIR_ACCELERATE * wishSpeed * dt;
  if (accelSpeed > addSpeed) accelSpeed = addSpeed;

  vel.x += accelSpeed * wishDir.x;
  vel.y += accelSpeed * wishDir.y;
  vel.z += accelSpeed * wishDir.z;
};

/** Desplaza y desliza contra la geometria. Devuelve el numero de planos tocados. */
const tryPlayerMove = (state: MoveState, world: CollisionWorld, dt: number): number => {
  const mins = playerMins();
  const maxs = playerMaxs(state.ducking);
  let timeLeft = dt;
  let bumps = 0;
  const planes: Vec3[] = [];

  for (let bump = 0; bump < 4 && timeLeft > 0; bump++) {
    if (state.vel.x === 0 && state.vel.y === 0 && state.vel.z === 0) break;

    const end = vec3(
      state.pos.x + state.vel.x * timeLeft,
      state.pos.y + state.vel.y * timeLeft,
      state.pos.z + state.vel.z * timeLeft,
    );

    const trace = traceBox(world, state.pos, end, mins, maxs);

    if (trace.startSolid) {
      // Situacion degenerada: detenemos al jugador en lugar de expulsarlo.
      copy(state.vel, vec3());
      return bumps;
    }

    if (trace.fraction > 0) {
      copy(state.pos, trace.endPos);
      timeLeft -= timeLeft * trace.fraction;
    }

    if (!trace.hit || trace.fraction >= 1) break;

    bumps++;
    // Separacion minima de la pared para no quedar pegado por error numerico.
    state.pos.x += trace.normal.x * DIST_EPSILON;
    state.pos.y += trace.normal.y * DIST_EPSILON;
    state.pos.z += trace.normal.z * DIST_EPSILON;

    planes.push(clone(trace.normal));

    let clipped = clipVelocity(state.vel, trace.normal);
    // Con dos planos (una esquina) hay que deslizar por la arista comun.
    if (planes.length >= 2) {
      const a = planes[planes.length - 2]!;
      const b = planes[planes.length - 1]!;
      const dotAB = a.x * b.x + a.y * b.y + a.z * b.z;
      if (dotAB < 0.99) {
        const edge = vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
        normalizeInPlace(edge);
        const d = clipped.x * edge.x + clipped.y * edge.y + clipped.z * edge.z;
        clipped = scale(edge, d);
      }
    }
    copy(state.vel, clipped);
  }

  return bumps;
};

/** True si la normal cuenta como suelo caminable. */
const isWalkable = (normal: Vec3): boolean => normal.z >= MAX_GROUND_NORMAL_Z;

/** Determina si el jugador esta apoyado y ajusta `onGround`. */
export const categorizePosition = (state: MoveState, world: CollisionWorld): void => {
  // Subiendo rapido: definitivamente en el aire.
  if (state.vel.z > 140) {
    state.onGround = false;
    return;
  }

  const mins = playerMins();
  const maxs = playerMaxs(state.ducking);
  const below = vec3(state.pos.x, state.pos.y, state.pos.z - 2);
  const trace = traceBox(world, state.pos, below, mins, maxs);

  if (trace.hit && !trace.startSolid && isWalkable(trace.normal)) {
    state.onGround = true;
    // Pegamos al suelo para que las escaleras no produzcan saltitos.
    copy(state.pos, trace.endPos);
    if (state.vel.z < 0) state.vel.z = 0;
  } else {
    state.onGround = false;
  }
};

/**
 * Movimiento en el suelo con subida de escalones: se prueba el desplazamiento
 * normal y otro elevado `STEP_SIZE`, y gana el que avance mas en horizontal.
 */
const stepMove = (state: MoveState, world: CollisionWorld, dt: number): void => {
  const mins = playerMins();
  const maxs = playerMaxs(state.ducking);

  const startPos = clone(state.pos);
  const startVel = clone(state.vel);

  tryPlayerMove(state, world, dt);
  const downPos = clone(state.pos);
  const downVel = clone(state.vel);

  // Segundo intento: subir, avanzar y volver a bajar.
  copy(state.pos, startPos);
  copy(state.vel, startVel);

  const up = vec3(startPos.x, startPos.y, startPos.z + STEP_SIZE);
  const upTrace = traceBox(world, startPos, up, mins, maxs);
  if (!upTrace.startSolid) {
    copy(state.pos, upTrace.endPos);
    tryPlayerMove(state, world, dt);

    const down = vec3(state.pos.x, state.pos.y, state.pos.z - STEP_SIZE * 2);
    const downTrace = traceBox(world, state.pos, down, mins, maxs);
    if (!downTrace.startSolid && (!downTrace.hit || isWalkable(downTrace.normal))) {
      copy(state.pos, downTrace.endPos);
    }
  }

  const downDist = (downPos.x - startPos.x) ** 2 + (downPos.y - startPos.y) ** 2;
  const upDist = (state.pos.x - startPos.x) ** 2 + (state.pos.y - startPos.y) ** 2;

  if (downDist >= upDist) {
    copy(state.pos, downPos);
    copy(state.vel, downVel);
  } else {
    // Conservamos la velocidad vertical del intento plano: subir un escalon no
    // debe anadir impulso hacia arriba.
    state.vel.z = downVel.z;
  }
};

/** Convierte los botones de movimiento en una direccion deseada normalizada. */
export const wishDirection = (buttons: number, yaw: number): { dir: Vec3; magnitude: number } => {
  const { forward, right } = angleVectors(yaw, 0);
  let f = 0;
  let s = 0;
  if (hasButton(buttons, BUTTON.FORWARD)) f += 1;
  if (hasButton(buttons, BUTTON.BACK)) f -= 1;
  if (hasButton(buttons, BUTTON.RIGHT)) s += 1;
  if (hasButton(buttons, BUTTON.LEFT)) s -= 1;

  const dir = vec3(forward.x * f + right.x * s, forward.y * f + right.y * s, 0);
  const magnitude = normalizeInPlace(dir);
  return { dir, magnitude: magnitude > 0 ? 1 : 0 };
};

/** Velocidad maxima efectiva segun postura, modificadores y arma. */
export const maxSpeedFor = (
  buttons: number,
  ducking: boolean,
  weaponSpeedMultiplier = 1,
): number => {
  let speed = MAX_SPEED * weaponSpeedMultiplier;
  if (ducking) speed *= DUCK_SPEED_MULTIPLIER;
  else if (hasButton(buttons, BUTTON.WALK)) speed *= WALK_SPEED_MULTIPLIER;
  return speed;
};

/** Actualiza el agachado. En el aire es instantaneo y desplaza el origen. */
const updateDuck = (
  state: MoveState,
  world: CollisionWorld,
  wantsDuck: boolean,
  dt: number,
): void => {
  const heightDelta = PLAYER_HEIGHT_STANDING - PLAYER_HEIGHT_DUCKED;

  if (wantsDuck) {
    if (state.ducking) {
      state.duckProgress = 1;
      return;
    }
    if (state.onGround) {
      state.duckProgress = Math.min(1, state.duckProgress + dt / DUCK_TRANSITION_TIME);
      if (state.duckProgress >= 1) state.ducking = true;
    } else {
      // Duck-jump: encoger las piernas sube los pies y deja la cabeza fija.
      state.ducking = true;
      state.duckProgress = 1;
      state.pos.z += heightDelta;
    }
    return;
  }

  if (!state.ducking) {
    state.duckProgress = Math.max(0, state.duckProgress - dt / DUCK_TRANSITION_TIME);
    return;
  }

  // Levantarse solo si hay hueco para el hull completo.
  const targetPos = state.onGround
    ? clone(state.pos)
    : vec3(state.pos.x, state.pos.y, state.pos.z - heightDelta);

  if (isPositionSolid(world, targetPos, playerMins(), playerMaxs(false))) {
    state.duckProgress = 1;
    return;
  }

  copy(state.pos, targetPos);
  state.ducking = false;
  state.duckProgress = Math.max(0, state.duckProgress - dt / DUCK_TRANSITION_TIME);
};

/** Avanza un tick de movimiento. Muta `state` y devuelve los eventos ocurridos. */
export const moveStep = (
  state: MoveState,
  cmd: UserCommand,
  world: CollisionWorld,
  weaponSpeedMultiplier = 1,
): MoveEvents => {
  const events: MoveEvents = {
    jumped: false,
    landed: false,
    landingSpeed: 0,
    bhop: false,
  };
  const dt = cmd.dt;

  state.yaw = cmd.yaw;
  state.pitch = cmd.pitch;

  const wasOnGround = state.onGround;
  const fallSpeed = -state.vel.z;

  updateDuck(state, world, hasButton(cmd.buttons, BUTTON.DUCK), dt);
  categorizePosition(state, world);

  // El reloj de la ventana de bhop solo corre con los pies en el suelo: en el
  // aire no hay nada que cronometrar. Se pone a cero abajo, al detectar el
  // contacto de verdad.
  if (state.onGround && wasOnGround) state.timeSinceLanding += dt;

  const jumpPressed = hasButton(cmd.buttons, BUTTON.JUMP);
  const { dir: wishDir, magnitude } = wishDirection(cmd.buttons, state.yaw);
  const maxSpeed = maxSpeedFor(cmd.buttons, state.ducking, weaponSpeedMultiplier);
  const wishSpeed = magnitude * maxSpeed;
  /** Carrera del arma equipada, sin contar postura: la base del techo de bhop. */
  const runSpeed = MAX_SPEED * weaponSpeedMultiplier;

  // Media gravedad antes del desplazamiento y media despues: integracion
  // simetrica, para que la altura del salto no dependa del tickrate.
  if (!state.onGround) state.vel.z -= GRAVITY * 0.5 * dt;

  if (state.onGround) {
    if (jumpPressed && !state.jumpHeld) {
      const speed = length2D(state.vel);
      // Bhop: saltar nada mas tocar suelo conserva lo ganado en el aire; llegar
      // tarde recorta al tope de siempre y la cadena se rompe. El techo alto
      // sigue existiendo para que la habilidad tenga premio, pero acotado.
      const chained = state.timeSinceLanding <= BHOP_WINDOW;
      // El `max` no es defensivo por gusto: apuntando con la mira la carrera se
      // desploma, y sin el, encadenar recortaria mas que no encadenar.
      const cap = chained ? Math.max(JUMP_SPEED_CAP, runSpeed * BHOP_SPEED_RATIO) : JUMP_SPEED_CAP;
      if (speed > cap) {
        const f = cap / speed;
        state.vel.x *= f;
        state.vel.y *= f;
      }
      state.vel.z = JUMP_IMPULSE;
      state.onGround = false;
      events.jumped = true;
      // Solo se anuncia como bhop si ademas se venia corriendo: dar saltitos a
      // tiempo en el sitio acierta la ventana pero no encadena nada, y premiarlo
      // con el mismo sonido ensenaria el ritmo equivocado.
      events.bhop = chained && speed > runSpeed * 0.8;
      accelerate(state.vel, wishDir, wishSpeed, ACCELERATE, dt);
      tryPlayerMove(state, world, dt);
    } else {
      // Dentro de la ventana el jugador todavia viene deslizando. Sin esta
      // excepcion la ventana seria decorativa: la friccion muerde un 8% por
      // tick, asi que a los dos ticks ya se ha comido lo ganado en el aire y
      // solo valdria saltar en el tick exacto del contacto -- 15 ms, imposible
      // de acertar por oido y justo lo que el aviso sonoro pretende ensenar.
      if (state.timeSinceLanding > BHOP_WINDOW) applyFriction(state.vel, dt);
      state.vel.z = 0;
      accelerate(state.vel, wishDir, wishSpeed, ACCELERATE, dt);
      stepMove(state, world, dt);
    }
  } else {
    airAccelerate(state.vel, wishDir, wishSpeed, dt);
    tryPlayerMove(state, world, dt);
  }

  state.jumpHeld = jumpPressed;

  if (!state.onGround) state.vel.z -= GRAVITY * 0.5 * dt;

  categorizePosition(state, world);
  if (state.onGround && state.vel.z < 0) state.vel.z = 0;

  // El aterrizaje se decide aqui y no antes de mover, que es donde estaba: la
  // primera comprobacion mira el suelo *antes* del desplazamiento del tick, asi
  // que cuando el jugador venia cayendo siempre lo veia en el aire y el evento
  // no llegaba a emitirse nunca. Con el ya se oye el golpe, la caida larga
  // cobra su penalizacion y la ventana de bhop tiene desde cuando contar.
  if (state.onGround && !wasOnGround) {
    events.landed = true;
    events.landingSpeed = fallSpeed;
    if (fallSpeed > LAND_PENALTY_MIN_FALL_SPEED) {
      state.vel.x *= LAND_SPEED_PENALTY;
      state.vel.y *= LAND_SPEED_PENALTY;
    }
    state.timeSinceLanding = 0;
  }

  return events;
};

/** Estado de movimiento inicial en una posicion dada. */
export const createMoveState = (pos: Vec3, yaw = 0): MoveState => ({
  pos: clone(pos),
  vel: vec3(),
  yaw,
  pitch: 0,
  onGround: false,
  ducking: false,
  duckProgress: 0,
  jumpHeld: false,
  timeSinceLanding: 0,
});

/**
 * Segundos que faltan para tocar suelo, o `null` si el jugador no esta cayendo
 * o no hay suelo a la vista.
 *
 * Es una prediccion balistica pura: mira recto hacia abajo e ignora que el
 * jugador se desplaza en horizontal mientras cae. Basta porque su unico uso es
 * avisar al jugador con antelacion de cuando pulsar salto -- no entra en la
 * simulacion, asi que equivocarse aqui no descuadra nada.
 */
export const timeToLanding = (
  state: MoveState,
  world: CollisionWorld,
  maxDrop = BHOP_CUE_MAX_DROP,
): number | null => {
  if (state.onGround || state.vel.z > 0) return null;

  const end = vec3(state.pos.x, state.pos.y, state.pos.z - maxDrop);
  const trace = traceBox(world, state.pos, end, playerMins(), playerMaxs(state.ducking));
  if (!trace.hit || trace.startSolid) return null;

  const drop = state.pos.z - trace.endPos.z;
  const fall = -state.vel.z;
  // d = v t + g t^2 / 2  =>  t = (sqrt(v^2 + 2 g d) - v) / g
  return (Math.sqrt(fall * fall + 2 * GRAVITY * drop) - fall) / GRAVITY;
};

/**
 * Contador de zancada. Vive fuera del `PlayerState` a proposito: no forma parte
 * del estado que se rebobina para compensar latencia, porque un paso ya sonado
 * no se puede "des-sonar".
 */
export interface FootstepTracker {
  distance: number;
}

export const createFootstepTracker = (): FootstepTracker => ({ distance: 0 });

/**
 * Avanza el contador y dice si suena una pisada en este paso de simulacion.
 *
 * El acumulador no se reinicia al bajar del umbral, y eso es deliberado: si se
 * reiniciase, avanzar a tirones cortos seria una forma gratuita de cruzar el
 * mapa en silencio. Asi, el ruido acaba saliendo igual.
 */
export const advanceFootstep = (
  tracker: FootstepTracker,
  speed: number,
  onGround: boolean,
  dt: number,
): boolean => {
  if (!onGround || speed < FOOTSTEP_MIN_SPEED) return false;

  tracker.distance += speed * dt;
  if (tracker.distance < FOOTSTEP_STRIDE) return false;

  tracker.distance -= FOOTSTEP_STRIDE;
  return true;
};
