/**
 * Instantaneas diferenciales.
 *
 * El estado completo son unos 580 bytes y sale 64 veces por segundo, pero de un
 * tick al siguiente casi todo es identico: el nombre, el arma, la vida, el
 * marcador y las estadisticas no cambian nunca, y lo que cambia es casi siempre
 * solo la posicion y los angulos.
 *
 * El transporte es WebSocket, o sea TCP: los mensajes llegan todos y en orden,
 * asi que la diferencia puede ir contra la instantanea inmediatamente anterior
 * sin necesidad de confirmaciones. Aun asi cada segundo se manda una completa,
 * para que cualquier desajuste se cure solo en vez de quedarse para siempre.
 */

import type { FullSnapshot, PlayerSnapshot, SnapshotMessage } from './protocol.js';

/** Instantanea parcial de un jugador: el `id` y solo lo que ha cambiado. */
export type PlayerDelta = { id: number } & Partial<Omit<PlayerSnapshot, 'id'>>;

export interface PlayersDiff {
  /** Jugadores nuevos (completos) y cambios de los que ya estaban. */
  players: PlayerDelta[];
  /** Los que ya no estan en la partida. */
  gone: number[];
}

/**
 * Compara dos valores de un campo de la instantanea.
 *
 * Un solo nivel de profundidad, que es lo que hay: `stats` es el unico campo
 * que no es un numero o una cadena, y dentro solo tiene numeros.
 */
const sameField = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
  );
};

/**
 * Lo que hay que mandar para pasar de `previous` a `current`.
 *
 * Los campos se recorren leyendolos del propio objeto, no de una lista escrita
 * a mano: anadir un campo a la instantanea no exige acordarse de este archivo.
 */
export const diffPlayers = (
  previous: readonly PlayerSnapshot[],
  current: readonly PlayerSnapshot[],
): PlayersDiff => {
  const before = new Map(previous.map((player) => [player.id, player]));
  const players: PlayerDelta[] = [];

  for (const now of current) {
    const old = before.get(now.id);
    // Un jugador que no estaba viaja entero: no hay nada sobre lo que aplicar.
    if (!old) {
      players.push({ ...now });
      continue;
    }

    const change: PlayerDelta = { id: now.id };
    let changed = false;
    for (const key of Object.keys(now) as (keyof PlayerSnapshot)[]) {
      if (key === 'id' || sameField(old[key], now[key])) continue;
      (change as Record<string, unknown>)[key] = now[key];
      changed = true;
    }
    if (changed) players.push(change);
  }

  const alive = new Set(current.map((player) => player.id));
  const gone = previous.filter((player) => !alive.has(player.id)).map((player) => player.id);
  return { players, gone };
};

/** Reconstruye la lista completa aplicando una diferencia sobre la anterior. */
export const applyPlayersDiff = (
  previous: readonly PlayerSnapshot[],
  diff: PlayersDiff,
): PlayerSnapshot[] => {
  const byId = new Map(previous.map((player) => [player.id, player]));

  for (const id of diff.gone) byId.delete(id);
  for (const change of diff.players) {
    const old = byId.get(change.id);
    byId.set(change.id, old ? { ...old, ...change } : (change as PlayerSnapshot));
  }

  return [...byId.values()];
};

/**
 * Reconstruye las instantaneas completas a partir de las diferenciales.
 *
 * Si llega una diferencia que no encaja con lo que se tiene --algo que TCP no
 * deberia permitir, pero un fallo silencioso aqui seria un mundo congelado sin
 * explicacion-- se descarta y se sigue descartando hasta la siguiente completa,
 * que el servidor manda una vez por segundo.
 */
export class SnapshotDecoder {
  private players: PlayerSnapshot[] = [];
  private tick = -1;

  reset(): void {
    this.players = [];
    this.tick = -1;
  }

  decode(message: SnapshotMessage): FullSnapshot | null {
    let players: PlayerSnapshot[];
    if (message.base === undefined) {
      players = message.players as PlayerSnapshot[];
    } else {
      if (message.base !== this.tick) return null;
      players = applyPlayersDiff(this.players, {
        players: message.players,
        gone: message.gone ?? [],
      });
    }

    this.players = players;
    this.tick = message.tick;
    return {
      ...(message.viewYaw === undefined ? {} : { viewYaw: message.viewYaw }),
      t: 'snapshot',
      tick: message.tick,
      time: message.time,
      ack: message.ack,
      players,
      phase: message.phase,
      phaseTime: message.phaseTime,
      round: message.round,
      events: message.events,
    };
  }
}
