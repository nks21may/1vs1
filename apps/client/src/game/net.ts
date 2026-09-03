/**
 * Conexion con el servidor.
 *
 * Encapsula el WebSocket, la medicion de latencia y el reenvio redundante de
 * comandos: cada paquete incluye los ultimos comandos ademas del nuevo, de modo
 * que perder un datagrama no produce un salto en el movimiento (el servidor
 * descarta por numero de secuencia lo que ya ha visto).
 */

import {
  INTERP_DELAY_MS,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SnapshotMessage,
  type UserCommand,
  type WelcomeMessage,
  parseServerMessage,
} from '@neonduel/shared';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export interface NetHandlers {
  onWelcome(message: WelcomeMessage): void;
  onSnapshot(message: SnapshotMessage, receivedAt: number): void;
  onStatus(status: ConnectionStatus, detail?: string): void;
}

/** Comandos que se reenvian junto al nuevo para tolerar perdidas. */
const REDUNDANT_COMMANDS = 3;
/** Intervalo entre medidas de latencia. */
const PING_INTERVAL_MS = 1000;

export class NetClient {
  private socket: WebSocket | null = null;
  private recentCommands: UserCommand[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private rttSamples: number[] = [];

  status: ConnectionStatus = 'idle';
  /** Ida y vuelta suavizada, en ms. */
  rtt = 0;

  constructor(private readonly handlers: NetHandlers) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(url: string, name: string): void {
    this.disconnect();
    this.setStatus('connecting');

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.setStatus('connected');
      this.send({ t: 'join', name, version: PROTOCOL_VERSION });
      this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
      this.sendPing();
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (message) this.handle(message);
    });

    socket.addEventListener('close', (event) => {
      this.stopPing();
      this.setStatus('closed', event.reason || undefined);
    });

    socket.addEventListener('error', () => {
      this.stopPing();
      this.setStatus('error', 'No se pudo conectar con el servidor');
    });
  }

  disconnect(): void {
    this.stopPing();
    this.socket?.close();
    this.socket = null;
    this.recentCommands = [];
    this.rttSamples = [];
  }

  /** Envia un comando junto a los ultimos, por redundancia. */
  sendCommand(cmd: UserCommand): void {
    this.recentCommands.push(cmd);
    if (this.recentCommands.length > REDUNDANT_COMMANDS + 1) {
      this.recentCommands.shift();
    }
    this.send({
      t: 'input',
      cmds: this.recentCommands,
      interp: INTERP_DELAY_MS,
      rtt: Math.round(this.rtt),
    });
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.handlers.onWelcome(message);
        break;
      case 'snapshot':
        this.handlers.onSnapshot(message, performance.now());
        break;
      case 'pong': {
        const sample = performance.now() - message.time;
        // Mediana de las ultimas medidas: ignora los picos sueltos, que si no
        // harian oscilar el rebobinado del servidor.
        this.rttSamples.push(sample);
        if (this.rttSamples.length > 5) this.rttSamples.shift();
        const sorted = [...this.rttSamples].sort((a, b) => a - b);
        this.rtt = sorted[Math.floor(sorted.length / 2)] ?? sample;
        break;
      }
    }
  }

  private sendPing(): void {
    this.send({ t: 'ping', time: performance.now() });
  }

  private send(message: unknown): void {
    if (!this.isOpen) return;
    this.socket!.send(JSON.stringify(message));
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.handlers.onStatus(status, detail);
  }
}

/** URL del WebSocket a partir de la pagina actual y las opciones de partida. */
export const buildServerUrl = (bot: string | null): string => {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('server');
  const base =
    explicit ??
    `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${
      // En desarrollo el cliente lo sirve Vite en otro puerto que el juego.
      window.location.port === '5173' ? `${window.location.hostname}:8080` : window.location.host
    }`;
  return bot ? `${base}/?bot=${encodeURIComponent(bot)}` : base;
};
