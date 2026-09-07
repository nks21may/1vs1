/**
 * Montaje del servidor: HTTP para los archivos del cliente y WebSocket para el
 * juego. Es la unica capa que toca sockets y relojes reales; toda la logica
 * vive en `GameServer` y `MatchSession`, que son deterministas.
 *
 * Se expone como funcion en lugar de ejecutarse al importar para que los tests
 * puedan levantar una instancia real en un puerto efimero y apagarla despues.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { PROTOCOL_VERSION, getMap, parseClientMessage, sanitizeName } from '@neonduel/shared';

import type { Connection } from './connection.js';
import { type BotSkill, GameServer, TICK_INTERVAL } from './game-server.js';
import { TickMeter } from './metrics.js';

/** Un mensaje legitimo no llega a 4 KB; mas que eso es ruido o un ataque. */
const MAX_MESSAGE_BYTES = 4096;
/** Presupuesto de mensajes por segundo y conexion. */
const MAX_MESSAGES_PER_SECOND = 200;

const BOT_SKILLS = new Set<string>(['easy', 'normal', 'hard']);

/**
 * `ws` entrega cada mensaje como Buffer, como ArrayBuffer o como lista de
 * Buffers segun como haya llegado troceado por la red; nunca como texto.
 */
const decodeMessage = (raw: RawData): string => {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
};

const CLIENT_DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Conexion respaldada por un WebSocket real. */
class SocketConnection implements Connection {
  name: string;

  constructor(
    readonly id: number,
    private readonly socket: WebSocket,
    name: string,
  ) {
    this.name = name;
  }

  send(message: Parameters<Connection['send']>[0]): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  close(reason?: string): void {
    this.socket.close(1000, reason?.slice(0, 120));
  }
}

export interface ServerHandle {
  http: Server;
  game: GameServer;
  /** Puerto real en el que escucha (util cuando se pide el 0). */
  port: number;
  stop(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  host?: string;
  /** Directorio con el cliente compilado. */
  clientDist?: string;
}

export const startServer = async (options: StartOptions = {}): Promise<ServerHandle> => {
  const port = options.port ?? Number(process.env.PORT ?? 8080);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const clientDist = options.clientDist ?? CLIENT_DIST;

  const game = new GameServer();
  // Se declara aqui y no junto al bucle porque `/health` tambien lo lee.
  const ticks = new TickMeter();

  const serveStatic = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          version: PROTOCOL_VERSION,
          // Ticks por segundo que el bucle consigue de verdad, no los 64
          // nominales. `null` durante el primer segundo, que no es lo mismo
          // que cero.
          tick: ticks.hz,
          sessions: game.sessionCount,
          matches: game.activeMatchCount,
          players: game.playerCount,
          reconnecting: game.pendingCount,
        }),
      );
      return;
    }

    // `normalize` mas la comprobacion del prefijo evitan salirse del directorio.
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = normalize(join(clientDist, requested));
    if (!filePath.startsWith(clientDist)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': requested === '/index.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'Cliente no compilado todavia. Ejecuta "npm run dev" para desarrollo o ' +
          '"npm run build" para generar los archivos estaticos.',
      );
    }
  };

  const http = createServer((req, res) => {
    void serveStatic(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal error');
    });
  });

  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const botSkill = url.searchParams.get('bot');
    // Mapa pedido por el cliente. Si el nombre no existe, se ignora y se juega
    // en el de siempre: un parametro raro no debe tumbar la conexion.
    const requestedMap = getMap(url.searchParams.get('map'));

    /** Null hasta que llega un `join` valido: antes no ocupa partida. */
    let connectionId: number | null = null;
    /** True si el jugador ha dicho que se va, en vez de caerse. */
    let deliberate = false;
    let messageBudget = MAX_MESSAGES_PER_SECOND;
    const budgetTimer = setInterval(() => {
      messageBudget = MAX_MESSAGES_PER_SECOND;
    }, 1000);

    socket.on('message', (raw) => {
      if (messageBudget-- <= 0) {
        socket.close(1008, 'Demasiados mensajes');
        return;
      }

      const text = decodeMessage(raw);
      if (text.length > MAX_MESSAGE_BYTES) return;

      const message = parseClientMessage(text);
      if (!message) return;

      if (connectionId === null) {
        // Hasta que no llega un `join` valido, la conexion no ocupa partida.
        if (message.t !== 'join') return;
        if (message.version !== PROTOCOL_VERSION) {
          socket.close(1002, 'Version de protocolo incompatible');
          return;
        }
        const name = sanitizeName(message.name);

        // Con un ticket vigente se vuelve a la partida en curso, y con el mismo
        // identificador: el jugador es el que era. Si ha caducado, o no es de
        // nadie, se entra como uno nuevo en vez de rechazar la conexion.
        const reclaimed = message.token ? game.reconnectableId(message.token) : null;
        if (reclaimed !== null) {
          const returning = new SocketConnection(reclaimed, socket, name);
          if (game.reconnect(reclaimed, returning)) {
            connectionId = reclaimed;
            return;
          }
        }

        const id = game.allocateConnectionId();
        const connection = new SocketConnection(id, socket, name);
        if (botSkill && BOT_SKILLS.has(botSkill)) {
          game.joinBotMatch(connection, botSkill as BotSkill, requestedMap);
        } else {
          game.joinMatch(connection, requestedMap);
        }
        connectionId = id;
        return;
      }

      if (message.t === 'leave') {
        deliberate = true;
        socket.close(1000, 'Hasta luego');
        return;
      }

      game.handleMessage(connectionId, message);
    });

    const cleanup = (): void => {
      clearInterval(budgetTimer);
      if (connectionId === null) return;
      // Irse y caerse no son lo mismo: al que se cae se le guarda el sitio.
      if (deliberate) game.leave(connectionId);
      else game.disconnect(connectionId);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // --- Bucle de simulacion ---
  let lastTime = Date.now();
  let accumulator = 0;

  const loop = setInterval(
    () => {
      const now = Date.now();
      accumulator += now - lastTime;
      lastTime = now;

      // Tope de recuperacion: tras una pausa larga del proceso no tiene sentido
      // simular cientos de ticks de golpe, es preferible descartarlos.
      if (accumulator > TICK_INTERVAL * 10) accumulator = TICK_INTERVAL * 10;

      while (accumulator >= TICK_INTERVAL) {
        accumulator -= TICK_INTERVAL;
        game.step();
        ticks.record(now);
      }
    },
    Math.max(1, Math.floor(TICK_INTERVAL / 2)),
  );

  await new Promise<void>((resolvePromise) => {
    http.listen(port, host, resolvePromise);
  });

  const address = http.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    http,
    game,
    port: actualPort,
    async stop() {
      clearInterval(loop);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
};
