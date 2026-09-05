/**
 * Test de extremo a extremo sobre el servidor real.
 *
 * Levanta el proceso completo (HTTP + WebSocket + bucle a 64 Hz) en un puerto
 * efimero y habla con el como lo haria el navegador. Cubre justo lo que los
 * tests unitarios no pueden ver: el encuadre de mensajes, la validacion del
 * borde, el emparejamiento y que el bucle temporal avanza de verdad.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  BUTTON,
  PROTOCOL_VERSION,
  TICK_DT,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@neonduel/shared';

import { startServer, type ServerHandle } from '../src/server.js';

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await server.stop();
});

/** `ws` entrega Buffer, ArrayBuffer o lista de Buffers, nunca texto. */
const textOf = (raw: WebSocket.RawData): string => {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
};

/** Cliente de pruebas: acumula lo recibido y expone esperas por tipo. */
class TestClient {
  readonly messages: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private seq = 0;
  private lastTick = 0;

  constructor(query = '') {
    this.socket = new WebSocket(`ws://127.0.0.1:${server.port}/${query}`);
    this.socket.on('message', (data) => {
      const message = JSON.parse(textOf(data)) as ServerMessage;
      // Igual que el navegador: el ultimo tick visto viaja en cada paquete de
      // entrada, y es con el con lo que el servidor mide la latencia.
      if (message.t === 'snapshot') this.lastTick = message.tick;
      this.messages.push(message);
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  join(name: string, version = PROTOCOL_VERSION): void {
    this.send({ t: 'join', name, version });
  }

  /** Envia un comando de movimiento y devuelve su numero de secuencia. */
  input(buttons: number, yaw = 0, pitch = 0): number {
    this.seq += 1;
    this.send({
      t: 'input',
      cmds: [{ seq: this.seq, buttons, yaw, pitch, dt: TICK_DT }],
      ackTick: this.lastTick,
    });
    return this.seq;
  }

  /** Espera al siguiente mensaje del tipo indicado. */
  async waitFor<T extends ServerMessage['t']>(
    type: T,
    timeoutMs = 3000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const existing = this.messages.find((m) => m.t === type);
    if (existing) return existing as Extract<ServerMessage, { t: T }>;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage);
        reject(new Error(`Sin mensaje "${type}" en ${timeoutMs} ms`));
      }, timeoutMs);

      const onMessage = (data: WebSocket.RawData): void => {
        const message = JSON.parse(textOf(data)) as ServerMessage;
        if (message.t !== type) return;
        clearTimeout(timer);
        this.socket.off('message', onMessage);
        resolve(message as Extract<ServerMessage, { t: T }>);
      };
      this.socket.on('message', onMessage);
    });
  }

  /** Espera a recibir `count` instantaneas mas. */
  async waitForSnapshots(count: number, timeoutMs = 5000): Promise<SnapshotMessage[]> {
    const collected: SnapshotMessage[] = [];
    const deadline = Date.now() + timeoutMs;
    while (collected.length < count) {
      if (Date.now() > deadline) throw new Error('Tiempo agotado esperando instantaneas');
      collected.push(await this.waitFor('snapshot', Math.max(1, deadline - Date.now())));
      this.messages.length = 0;
    }
    return collected;
  }

  get closed(): boolean {
    return (
      this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING
    );
  }

  async waitForClose(timeoutMs = 3000): Promise<number> {
    if (this.socket.readyState === WebSocket.CLOSED) return 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No se cerro')), timeoutMs);
      this.socket.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

describe('HTTP', () => {
  it('responde a la sonda de salud', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it('no deja salir del directorio del cliente', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/../../../package.json`);
    // El navegador normaliza la ruta; en cualquier caso nunca debe servir el archivo.
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('conexion de un jugador', () => {
  it('recibe la bienvenida tras el join', async () => {
    const client = new TestClient('?bot=easy');
    await client.open();
    client.join('E2E');

    const welcome: WelcomeMessage = await client.waitFor('welcome');
    expect(welcome).toMatchObject({ mapName: 'ATRIUM', tickRate: 64, version: PROTOCOL_VERSION });
    client.close();
  });

  it('rechaza una version de protocolo distinta', async () => {
    const client = new TestClient();
    await client.open();
    client.join('VIEJO', 999);

    await expect(client.waitForClose()).resolves.toBe(1002);
  });

  it('ignora los mensajes previos al join', async () => {
    const client = new TestClient();
    await client.open();
    client.input(BUTTON.FORWARD);
    client.send({ t: 'ping', time: 1 });

    // Sin join no entra en ninguna partida, asi que no llega nada de juego.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.messages).toHaveLength(0);
    client.close();
  });

  it('descarta los paquetes malformados sin cerrar la conexion', async () => {
    const client = new TestClient('?bot=easy');
    await client.open();
    client.join('E2E');
    await client.waitFor('welcome');

    client.send({ t: 'input', cmds: [{ seq: 'no', buttons: {}, dt: 999 }] });
    client.send('{{{ esto no es json');

    // La conexion sigue viva y el juego continua.
    await client.waitFor('snapshot');
    expect(client.closed).toBe(false);
    client.close();
  });
});

describe('bucle de juego real', () => {
  it('emite instantaneas de forma continua', async () => {
    const client = new TestClient('?bot=normal');
    await client.open();
    client.join('E2E');
    await client.waitFor('welcome');

    const start = Date.now();
    const snapshots = await client.waitForSnapshots(20);
    const elapsed = Date.now() - start;

    expect(snapshots).toHaveLength(20);
    // 20 ticks a 64 Hz son ~312 ms; se deja margen amplio por el planificador.
    expect(elapsed).toBeLessThan(2000);
    expect(snapshots[19]!.tick).toBeGreaterThan(snapshots[0]!.tick);
    client.close();
  });

  it('responde al ping con la marca de tiempo del cliente', async () => {
    const client = new TestClient('?bot=easy');
    await client.open();
    client.join('E2E');
    await client.waitFor('welcome');

    client.send({ t: 'ping', time: 424242 });
    const pong = await client.waitFor('pong');
    expect(pong.time).toBe(424242);
    client.close();
  });

  it('la partida contra bot arranca con dos jugadores', async () => {
    const client = new TestClient('?bot=hard');
    await client.open();
    client.join('E2E');
    await client.waitFor('welcome');

    const snapshot = await client.waitFor('snapshot');
    expect(snapshot.players).toHaveLength(2);
    expect(snapshot.players.some((p) => p.name.startsWith('BOT_'))).toBe(true);
    client.close();
  });

  // Warmup (3 s) + congelacion (2 s) antes de poder moverse: el limite por
  // defecto de 5 s se queda justo.
  it('los comandos mueven al jugador y el servidor los confirma', { timeout: 25000 }, async () => {
    const client = new TestClient('?bot=easy');
    await client.open();
    client.join('E2E');
    const welcome = await client.waitFor('welcome');

    // Esperar a que la ronda este en juego antes de intentar moverse.
    let snapshot = await client.waitFor('snapshot');
    const deadline = Date.now() + 15000;
    while (snapshot.phase !== 'live' && Date.now() < deadline) {
      client.messages.length = 0;
      snapshot = await client.waitFor('snapshot');
    }
    expect(snapshot.phase).toBe('live');

    const self = snapshot.players.find((p) => p.id === welcome.playerId)!;
    const startX = self.x;

    let lastSeq = 0;
    for (let i = 0; i < 40; i++) {
      lastSeq = client.input(BUTTON.FORWARD, 0);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }

    client.messages.length = 0;
    const latest = await client.waitFor('snapshot');
    const moved = latest.players.find((p) => p.id === welcome.playerId)!;

    expect(latest.ack).toBeGreaterThan(0);
    expect(latest.ack).toBeLessThanOrEqual(lastSeq);
    expect(Math.abs(moved.x - startX)).toBeGreaterThan(20);
    client.close();
  });
});

describe('emparejamiento entre dos clientes', () => {
  it('junta a dos jugadores en la misma partida y se ven', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.open(), b.open()]);

    a.join('ALFA');
    b.join('BETA');

    const welcomeA = await a.waitFor('welcome');
    const welcomeB = await b.waitFor('welcome');
    expect(welcomeA.matchId).toBe(welcomeB.matchId);

    const snapshot = await a.waitFor('snapshot');
    expect(snapshot.players.map((p) => p.name).sort()).toEqual(['ALFA', 'BETA']);

    a.close();
    b.close();
  });

  it('al desconectarse uno, el otro gana la partida', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await Promise.all([a.open(), b.open()]);
    a.join('QUEDA');
    b.join('SEVA');

    await a.waitFor('welcome');
    await b.waitFor('welcome');
    await a.waitFor('snapshot');

    b.close();

    const deadline = Date.now() + 4000;
    let sawMatchEnd = false;
    while (!sawMatchEnd && Date.now() < deadline) {
      a.messages.length = 0;
      const snapshot = await a.waitFor('snapshot');
      sawMatchEnd = snapshot.events.some((e) => e.t === 'matchEnd');
    }

    expect(sawMatchEnd).toBe(true);
    a.close();
  });
});
