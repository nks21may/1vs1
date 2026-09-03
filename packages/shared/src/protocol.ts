/**
 * Protocolo de red.
 *
 * Se usa JSON: con dos jugadores a 64 Hz el ancho de banda es de unos 15 KB/s,
 * asi que la legibilidad y la facilidad de depuracion pesan mas que exprimir
 * bytes. Los valores de posicion se redondean antes de enviarse, que es de
 * donde sale la mayor parte del ahorro real.
 *
 * Todo mensaje entrante se valida aqui: el servidor nunca confia en el cliente,
 * y un paquete malformado se descarta en lugar de propagar `NaN` a la fisica.
 */

import { MAX_COMMANDS_PER_PACKET, MAX_PITCH, TICK_DT } from './constants.js';
import type { MatchPhase, RoundEndReason } from './match.js';
import type { UserCommand } from './movement.js';
import type { HitGroup, WeaponId } from './weapons.js';

export const PROTOCOL_VERSION = 1;

// --- Cliente -> Servidor ---

export interface JoinMessage {
  t: 'join';
  name: string;
  version: number;
}

export interface InputMessage {
  t: 'input';
  /** Comandos redundantes: se reenvian los ultimos por si se pierde un paquete. */
  cmds: UserCommand[];
  /** Retardo de interpolacion que el cliente esta aplicando, en ms. */
  interp: number;
  /**
   * Ida y vuelta medida por el cliente, en ms. El servidor la usa para rebobinar
   * al instante que el cliente veia. Es un dato declarado por el cliente, asi
   * que se acota aqui y otra vez en `computeRewindTime`: lo maximo que se puede
   * conseguir mintiendo es un rebobinado de `MAX_REWIND_MS`.
   */
  rtt: number;
}

export interface PingMessage {
  t: 'ping';
  /** Marca de tiempo del cliente, devuelta tal cual en el pong. */
  time: number;
}

export type ClientMessage = JoinMessage | InputMessage | PingMessage;

// --- Servidor -> Cliente ---

export interface WelcomeMessage {
  t: 'welcome';
  playerId: number;
  mapName: string;
  tickRate: number;
  matchId: string;
  version: number;
}

export interface PlayerSnapshot {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  /** Bit 0: agachado, bit 1: en el suelo, bit 2: vivo. */
  flags: number;
  health: number;
  weapon: WeaponId;
  ammo: number;
  /** Progreso de recarga en [0, 1]; 0 si no esta recargando. */
  reload: number;
  score: number;
}

export const SNAPSHOT_FLAG = {
  DUCKING: 1,
  ON_GROUND: 2,
  ALIVE: 4,
} as const;

export type GameEvent =
  | {
      t: 'shot';
      id: number;
      weapon: WeaponId;
      ox: number;
      oy: number;
      oz: number;
      ex: number;
      ey: number;
      ez: number;
      /** True si el disparo lo genero el jugador local (ya predicho). */
      local?: boolean;
    }
  | {
      t: 'impact';
      x: number;
      y: number;
      z: number;
      nx: number;
      ny: number;
      nz: number;
    }
  | {
      t: 'hit';
      attacker: number;
      victim: number;
      group: HitGroup;
      damage: number;
      x: number;
      y: number;
      z: number;
    }
  | { t: 'death'; victim: number; killer: number | null; group: HitGroup | null }
  | { t: 'jump'; id: number }
  | { t: 'land'; id: number; speed: number }
  | { t: 'step'; id: number; x: number; y: number; z: number }
  | { t: 'reload'; id: number }
  | { t: 'switch'; id: number; weapon: WeaponId }
  | { t: 'roundStart'; round: number }
  | { t: 'roundEnd'; round: number; winnerId: number | null; reason: RoundEndReason }
  | { t: 'matchEnd'; winnerId: number | null };

export interface SnapshotMessage {
  t: 'snapshot';
  /**
   * Angulo de vista que este cliente debe adoptar de golpe, en grados.
   *
   * Los angulos los manda el cliente en cada comando, asi que el servidor no
   * puede limitarse a girar al jugador al reaparecer: los comandos en vuelo,
   * que todavia llevan el angulo viejo, lo pisarian en el mismo tick. Con este
   * campo el servidor pide explicitamente el giro y el cliente lo aplica a su
   * entrada, que es quien manda. Solo viaja en el tick de la reaparicion.
   */
  viewYaw?: number;
  tick: number;
  /** Reloj del servidor en ms, usado para la interpolacion del cliente. */
  time: number;
  /** Ultimo comando del destinatario que el servidor ha procesado. */
  ack: number;
  players: PlayerSnapshot[];
  phase: MatchPhase;
  /** Segundos restantes de la fase actual. */
  phaseTime: number;
  round: number;
  events: GameEvent[];
}

export interface PongMessage {
  t: 'pong';
  time: number;
  server: number;
}

export type ServerMessage = WelcomeMessage | SnapshotMessage | PongMessage;

// --- Validacion de la entrada ---

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Tolerancia sobre el `dt` esperado: acepta ruido pero no comandos inflados. */
const MAX_COMMAND_DT = TICK_DT * 2.5;

const parseCommand = (raw: unknown): UserCommand | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const cmd = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(cmd.seq) ||
    !isFiniteNumber(cmd.buttons) ||
    !isFiniteNumber(cmd.yaw) ||
    !isFiniteNumber(cmd.pitch) ||
    !isFiniteNumber(cmd.dt)
  ) {
    return null;
  }
  if (cmd.seq < 0 || cmd.seq > Number.MAX_SAFE_INTEGER) return null;
  if (cmd.dt <= 0 || cmd.dt > MAX_COMMAND_DT) return null;

  return {
    seq: Math.floor(cmd.seq),
    // Mascara de 16 bits: descarta cualquier bit inventado.
    buttons: Math.floor(cmd.buttons) & 0xffff,
    yaw: normalizeYaw(cmd.yaw),
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, cmd.pitch)),
    dt: cmd.dt,
  };
};

const normalizeYaw = (yaw: number): number => {
  const wrapped = ((yaw % 360) + 540) % 360;
  return wrapped - 180;
};

/** Parsea y valida un mensaje del cliente. Devuelve null si es invalido. */
export const parseClientMessage = (raw: string): ClientMessage | null => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const msg = data as Record<string, unknown>;

  switch (msg.t) {
    case 'join': {
      if (typeof msg.name !== 'string') return null;
      const version = isFiniteNumber(msg.version) ? msg.version : 0;
      return { t: 'join', name: sanitizeName(msg.name), version };
    }
    case 'input': {
      if (!Array.isArray(msg.cmds)) return null;
      if (msg.cmds.length === 0 || msg.cmds.length > MAX_COMMANDS_PER_PACKET) return null;
      const cmds: UserCommand[] = [];
      for (const rawCmd of msg.cmds) {
        const cmd = parseCommand(rawCmd);
        if (!cmd) return null;
        cmds.push(cmd);
      }
      const interp = isFiniteNumber(msg.interp) ? Math.max(0, Math.min(500, msg.interp)) : 0;
      const rtt = isFiniteNumber(msg.rtt) ? Math.max(0, Math.min(1000, msg.rtt)) : 0;
      return { t: 'input', cmds, interp, rtt };
    }
    case 'ping': {
      if (!isFiniteNumber(msg.time)) return null;
      return { t: 'ping', time: msg.time };
    }
    default:
      return null;
  }
};

/** Recorta el nombre y elimina caracteres de control. */
export const sanitizeName = (name: string): string => {
  const cleaned = Array.from(name)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();
  return (cleaned || 'ANON').slice(0, 16);
};

/** Redondeo a dos decimales: recorta el tamano del snapshot sin artefactos visibles. */
export const round2 = (value: number): number => Math.round(value * 100) / 100;

export const encodeServerMessage = (message: ServerMessage): string =>
  JSON.stringify(message);

export const parseServerMessage = (raw: string): ServerMessage | null => {
  try {
    const data = JSON.parse(raw) as ServerMessage;
    if (typeof data !== 'object' || data === null) return null;
    if (typeof (data as { t?: unknown }).t !== 'string') return null;
    return data;
  } catch {
    return null;
  }
};
