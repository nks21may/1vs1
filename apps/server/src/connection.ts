/**
 * Abstraccion del transporte.
 *
 * La sesion de juego habla con este interfaz y no con un WebSocket concreto:
 * eso permite simular partidas completas en los tests (y conectar bots) sin
 * abrir un solo socket.
 */

import { SnapshotDecoder, type FullSnapshot, type ServerMessage } from '@neonduel/shared';

export interface Connection {
  readonly id: number;
  /** Nombre elegido por el jugador; se rellena al recibir el `join`. */
  name: string;
  send(message: ServerMessage): void;
  close(reason?: string): void;
  /** True si el participante es un bot local (no se le envian snapshots). */
  readonly isBot?: boolean;
}

/** Conexion en memoria: guarda lo enviado. Usada por bots y por los tests. */
export class MemoryConnection implements Connection {
  readonly sent: ServerMessage[] = [];
  closed = false;
  closeReason: string | undefined;

  constructor(
    readonly id: number,
    public name = `PLAYER_${id}`,
    readonly isBot = false,
  ) {}

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(reason?: string): void {
    this.closed = true;
    this.closeReason = reason;
  }

  /** Ultimo mensaje de un tipo concreto, o undefined. */
  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const message = this.sent[i]!;
      if (message.t === type) return message as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }

  /** Todos los mensajes de un tipo. */
  all<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === type) as Extract<ServerMessage, { t: T }>[];
  }

  /**
   * Las instantaneas ya reconstruidas, como las ve un cliente: por el cable
   * casi todas son diferencias y solo traen lo que ha cambiado.
   */
  fullSnapshots(): FullSnapshot[] {
    const decoder = new SnapshotDecoder();
    return this.all('snapshot')
      .map((message) => decoder.decode(message))
      .filter((snapshot): snapshot is FullSnapshot => snapshot !== null);
  }

  /** La ultima instantanea reconstruida. */
  lastFull(): FullSnapshot | undefined {
    return this.fullSnapshots().at(-1);
  }
}
