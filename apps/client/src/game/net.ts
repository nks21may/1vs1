/**
 * Conexion con el servidor.
 *
 * Encapsula el WebSocket, la medicion de latencia y el reenvio redundante de
 * comandos: cada paquete incluye los ultimos comandos ademas del nuevo, de modo
 * que perder un datagrama no produce un salto en el movimiento (el servidor
 * descarta por numero de secuencia lo que ya ha visto).
 */

import {
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
/**
 * Intentos de volver a la partida tras una caida, y espera entre ellos. El
 * producto tiene que caber holgadamente en la ventana que el servidor guarda
 * el sitio (`RECONNECT_GRACE_SECONDS`), o se reintenta contra un hueco que ya
 * no existe.
 */
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1200;

export class NetClient {
  private socket: WebSocket | null = null;
  private recentCommands: UserCommand[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private rttSamples: number[] = [];
  /**
   * Ultima instantanea aplicada. Viaja con cada paquete de entrada porque es
   * con lo que el servidor mide la latencia: el numero que se le manda no es
   * una latencia declarada, sino un tick que el mismo produjo.
   */
  private lastSnapshotTick = 0;
  /** Ticket para volver a la partida en curso si se cae el socket. */
  private token: string | null = null;
  /** A donde reconectar. Se guarda del `connect` para poder repetirlo. */
  private target: { url: string; name: string } | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True mientras el cierre es voluntario, para no intentar volver. */
  private leaving = false;

  status: ConnectionStatus = 'idle';
  /** Ida y vuelta suavizada, en ms. */
  rtt = 0;

  constructor(private readonly handlers: NetHandlers) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(url: string, name: string): void {
    this.disconnect();
    this.leaving = false;
    this.target = { url, name };
    this.reconnectAttempts = 0;
    this.open();
  }

  private open(): void {
    const target = this.target;
    if (!target) return;

    this.setStatus('connecting');
    const socket = new WebSocket(target.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.setStatus('connected');
      // Con ticket, el servidor devuelve el jugador que ya se tenia; sin el,
      // esto es una partida nueva.
      this.send({
        t: 'join',
        name: target.name,
        version: PROTOCOL_VERSION,
        ...(this.token === null ? {} : { token: this.token }),
      });
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
      // Los comandos redundantes son de antes de la caida: reenviarlos al
      // volver moveria al jugador por ordenes que ya no quiere dar.
      this.recentCommands = [];
      if (this.leaving) {
        this.setStatus('closed', event.reason || undefined);
        return;
      }
      this.scheduleReconnect(event.reason || undefined);
    });

    socket.addEventListener('error', () => {
      // El `close` viene siempre detras y es quien decide si se reintenta; aqui
      // solo hay algo que decir si nunca se llego a entrar.
      if (this.token === null) this.setStatus('error', 'No se pudo conectar con el servidor');
    });
  }

  /**
   * Vuelve a intentarlo mientras quede ticket y paciencia. Sin ticket no hay
   * nada que recuperar: la partida no habia empezado.
   */
  private scheduleReconnect(detail?: string): void {
    if (this.token === null || this.reconnectAttempts >= RECONNECT_ATTEMPTS) {
      this.setStatus('closed', detail);
      return;
    }

    this.reconnectAttempts += 1;
    this.setStatus('connecting', `Reconectando (${this.reconnectAttempts}/${RECONNECT_ATTEMPTS})`);
    this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_DELAY_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  disconnect(): void {
    this.leaving = true;
    this.clearReconnect();
    this.stopPing();
    // Irse y caerse no son lo mismo para el servidor: al que se cae le guarda
    // el sitio unos segundos, y el rival no tiene por que esperarlos.
    this.send({ t: 'leave' });
    this.socket?.close();
    this.socket = null;
    this.recentCommands = [];
    this.rttSamples = [];
    this.lastSnapshotTick = 0;
    this.token = null;
    this.target = null;
  }

  /** Envia un comando junto a los ultimos, por redundancia. */
  sendCommand(cmd: UserCommand): void {
    this.recentCommands.push(cmd);
    if (this.recentCommands.length > REDUNDANT_COMMANDS + 1) {
      this.recentCommands.shift();
    }
    this.send({ t: 'input', cmds: this.recentCommands, ackTick: this.lastSnapshotTick });
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.token = message.token ?? null;
        this.reconnectAttempts = 0;
        this.handlers.onWelcome(message);
        break;
      case 'snapshot':
        this.lastSnapshotTick = message.tick;
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
export const buildServerUrl = (bot: string | null, map?: string | null): string => {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('server');
  const base =
    explicit ??
    `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${
      // En desarrollo el cliente lo sirve Vite en otro puerto que el juego.
      window.location.port === '5173' ? `${window.location.hostname}:8080` : window.location.host
    }`;
  const query = new URLSearchParams();
  if (bot) query.set('bot', bot);
  if (map) query.set('map', map);
  const cadena = query.toString();
  return cadena ? `${base}/?${cadena}` : base;
};
