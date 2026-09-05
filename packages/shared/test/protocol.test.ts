import { describe, expect, it } from 'vitest';

import { MAX_COMMANDS_PER_PACKET, MAX_PITCH, TICK_DT } from '../src/constants.js';
import {
  encodeServerMessage,
  parseClientMessage,
  parseServerMessage,
  round2,
  sanitizeName,
} from '../src/protocol.js';

const inputPacket = (cmds: unknown[], ackTick: unknown = 40) =>
  JSON.stringify({ t: 'input', cmds, ackTick });

const validCommand = {
  seq: 5,
  buttons: 1,
  yaw: 45,
  pitch: 10,
  dt: TICK_DT,
};

describe('parseClientMessage', () => {
  it('rechaza JSON invalido', () => {
    expect(parseClientMessage('{no es json')).toBeNull();
  });

  it('rechaza tipos desconocidos', () => {
    expect(parseClientMessage('{"t":"hack"}')).toBeNull();
    expect(parseClientMessage('"cadena"')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
  });

  it('acepta un join y limpia el nombre', () => {
    const msg = parseClientMessage('{"t":"join","name":"  NEO  ","version":1}');
    expect(msg).toEqual({ t: 'join', name: 'NEO', version: 1 });
  });

  it('acepta un paquete de entrada valido', () => {
    const msg = parseClientMessage(inputPacket([validCommand]));
    expect(msg?.t).toBe('input');
    expect(msg).toMatchObject({ ackTick: 40 });
  });

  it('rechaza paquetes vacios o demasiado grandes', () => {
    expect(parseClientMessage(inputPacket([]))).toBeNull();
    const many = Array.from({ length: MAX_COMMANDS_PER_PACKET + 1 }, () => validCommand);
    expect(parseClientMessage(inputPacket(many))).toBeNull();
  });

  it('rechaza NaN e infinitos antes de que lleguen a la fisica', () => {
    expect(
      parseClientMessage(
        '{"t":"input","cmds":[{"seq":1,"buttons":0,"yaw":null,"pitch":0,"dt":0.015}]}',
      ),
    ).toBeNull();
    expect(parseClientMessage(inputPacket([{ ...validCommand, yaw: 'mucho' }]))).toBeNull();
  });

  it('rechaza un dt inflado que aceleraria al jugador', () => {
    expect(parseClientMessage(inputPacket([{ ...validCommand, dt: 5 }]))).toBeNull();
    expect(parseClientMessage(inputPacket([{ ...validCommand, dt: 0 }]))).toBeNull();
    expect(parseClientMessage(inputPacket([{ ...validCommand, dt: -0.1 }]))).toBeNull();
  });

  it('acota el pitch al rango jugable', () => {
    const msg = parseClientMessage(inputPacket([{ ...validCommand, pitch: 500 }]));
    expect(msg).toMatchObject({ cmds: [expect.objectContaining({ pitch: MAX_PITCH })] });
  });

  it('envuelve el yaw en lugar de rechazarlo', () => {
    const msg = parseClientMessage(inputPacket([{ ...validCommand, yaw: 725 }]));
    const cmd = (msg as { cmds: { yaw: number }[] }).cmds[0]!;
    expect(cmd.yaw).toBeCloseTo(5, 6);
  });

  it('descarta los bits de boton inventados', () => {
    const msg = parseClientMessage(inputPacket([{ ...validCommand, buttons: 0xffffffff }]));
    const cmd = (msg as { cmds: { buttons: number }[] }).cmds[0]!;
    expect(cmd.buttons).toBeLessThanOrEqual(0xffff);
  });

  it('acepta la ranura de arma y anula las que no existen', () => {
    const ranura = (slot: unknown) => {
      const msg = parseClientMessage(inputPacket([{ ...validCommand, slot }]));
      return (msg as { cmds: { slot?: number }[] }).cmds[0]!.slot;
    };

    expect(ranura(3)).toBe(3);
    expect(ranura(2.7)).toBe(2);
    // Todo lo demas es "no pido nada": una ranura inventada no puede dejar al
    // jugador con un arma que no existe ni tumbar la simulacion.
    expect(ranura(0)).toBe(0);
    expect(ranura(-1)).toBe(0);
    expect(ranura(99)).toBe(0);
    expect(ranura('2')).toBe(0);
    expect(ranura(NaN)).toBe(0);
    expect(ranura(undefined)).toBe(0);
  });

  it('el tick reconocido es un entero no negativo', () => {
    expect(parseClientMessage(inputPacket([validCommand], 12.7))).toMatchObject({ ackTick: 12 });
    expect(parseClientMessage(inputPacket([validCommand], -50))).toMatchObject({ ackTick: 0 });
    expect(parseClientMessage(inputPacket([validCommand], 'x'))).toMatchObject({ ackTick: 0 });
    // Ausente es valido: significa que aun no se ha visto ninguna instantanea.
    expect(parseClientMessage(JSON.stringify({ t: 'input', cmds: [validCommand] }))).toMatchObject({
      ackTick: 0,
    });
  });

  it('el paquete de entrada ya no admite una latencia declarada', () => {
    // Antes el cliente mandaba su propio `rtt` y el servidor rebobinaba con el.
    // Ahora la mide el servidor, asi que el campo no llega a existir.
    const msg = parseClientMessage(
      JSON.stringify({ t: 'input', cmds: [validCommand], ackTick: 40, rtt: 99999, interp: 500 }),
    );
    expect(msg).toMatchObject({ t: 'input', ackTick: 40 });
    expect(Object.keys(msg!).sort()).toEqual(['ackTick', 'cmds', 't']);
  });

  it('un ping conserva la marca de tiempo del cliente', () => {
    expect(parseClientMessage('{"t":"ping","time":1234}')).toEqual({
      t: 'ping',
      time: 1234,
    });
    expect(parseClientMessage('{"t":"ping"}')).toBeNull();
  });
});

describe('sanitizeName', () => {
  it('recorta a 16 caracteres', () => {
    expect(sanitizeName('A'.repeat(50))).toHaveLength(16);
  });

  it('elimina caracteres de control', () => {
    expect(sanitizeName('ne\u0000o\u001bx')).toBe('neox');
  });

  it('un nombre vacio recibe uno por defecto', () => {
    expect(sanitizeName('   ')).toBe('ANON');
  });
});

describe('serializacion', () => {
  it('el snapshot sobrevive a la ida y vuelta', () => {
    const message = {
      t: 'snapshot' as const,
      tick: 10,
      time: 1234,
      ack: 9,
      players: [],
      phase: 'live' as const,
      phaseTime: 12.5,
      round: 2,
      events: [],
    };
    expect(parseServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it('un mensaje de servidor corrupto devuelve null', () => {
    expect(parseServerMessage('{')).toBeNull();
    expect(parseServerMessage('[]')).toBeNull();
    expect(parseServerMessage('{"sin":"tipo"}')).toBeNull();
  });

  it('round2 recorta a dos decimales', () => {
    expect(round2(1.23456)).toBe(1.23);
    expect(round2(-0.005)).toBe(-0);
  });
});
