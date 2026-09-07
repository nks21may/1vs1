/**
 * El medidor del bucle.
 *
 * No usa relojes de verdad: se le pasan las marcas de tiempo, asi que los tests
 * son instantaneos y no dependen de lo cargada que este la maquina.
 */

import { describe, expect, it } from 'vitest';

import { TICK_INTERVAL } from '../src/game-server.js';
import { TickMeter } from '../src/metrics.js';

/** Simula `ticks` a un ritmo constante de `hz`, empezando en `from`. */
const run = (meter: TickMeter, ticks: number, hz: number, from = 0): number => {
  const step = 1000 / hz;
  let now = from;
  for (let i = 0; i < ticks; i++) {
    now += step;
    meter.record(now);
  }
  return now;
};

describe('TickMeter', () => {
  it('sin una ventana entera todavia no dice nada', () => {
    const meter = new TickMeter();
    run(meter, 10, 64);

    // No es cero: cero seria decir que el bucle esta parado.
    expect(meter.hz).toBeNull();
  });

  it('mide el ritmo real del bucle', () => {
    const meter = new TickMeter();
    run(meter, 70, 64);

    expect(meter.hz).toBeCloseTo(64, 0);
  });

  it('un bucle que no llega se ve en la medida', () => {
    const meter = new TickMeter();
    run(meter, 60, 40);

    expect(meter.hz).toBeCloseTo(40, 0);
  });

  it('los ticks de recuperacion no rompen la cuenta', () => {
    const meter = new TickMeter();
    // El bucle simula diez de golpe tras una pausa: todos con la misma marca.
    for (let i = 0; i < 10; i++) meter.record(0);
    run(meter, 64, 64, 0);

    expect(meter.hz).not.toBeNull();
    expect(Number.isFinite(meter.hz)).toBe(true);
  });

  it('se olvida de la ventana anterior al cerrar la siguiente', () => {
    const meter = new TickMeter();
    const hasta = run(meter, 70, 64);
    expect(meter.hz).toBeCloseTo(64, 0);

    // La ventana que pilla el cambio de ritmo sale a medias, que es lo honesto;
    // hay que dejar pasar una entera al ritmo nuevo para leerlo limpio.
    run(meter, 80, 32, hasta);
    expect(meter.hz).toBeCloseTo(32, 0);
  });

  it('el intervalo del bucle y el ritmo nominal son el mismo numero', () => {
    // Si esto deja de cumplirse, la medida se compararia contra otra cosa.
    const meter = new TickMeter();
    run(meter, 70, 1000 / TICK_INTERVAL);

    expect(meter.hz).toBeCloseTo(64, 0);
  });
});
