/**
 * @vitest-environment jsdom
 *
 * Tests de la capa de entrada. Es codigo de cliente pero no toca WebGL, asi que
 * se puede probar entero con un DOM simulado. Lo que se comprueba aqui -- que
 * el movimiento del raton se acumule sin perder muestras, que el cabeceo se
 * limite y que soltar el foco suelte las teclas -- son fallos que en juego se
 * traducen en la vista quedandose girando sola o el jugador andando solo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUTTON, MAX_PITCH } from '@neonduel/shared';

import { InputManager } from '../src/game/input.js';

let element: HTMLElement;
let input: InputManager;

beforeEach(() => {
  element = document.createElement('div');
  document.body.append(element);
  input = new InputManager(element);
  input.attach();
});

afterEach(() => {
  input.detach();
  element.remove();
});

const key = (type: 'keydown' | 'keyup', code: string): void => {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
};

const mouseMove = (movementX: number, movementY: number): void => {
  const event = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(event, 'movementX', { value: movementX });
  Object.defineProperty(event, 'movementY', { value: movementY });
  document.dispatchEvent(event);
};

/** Simula la captura del puntero, que el jsdom no implementa. */
const lock = (): void => {
  Object.defineProperty(document, 'pointerLockElement', {
    value: element,
    configurable: true,
  });
  document.dispatchEvent(new Event('pointerlockchange'));
};

describe('ranuras de arma', () => {
  it('cada numero pide siempre la misma arma', () => {
    key('keydown', 'Digit3');
    expect(input.consume().slot).toBe(3);
  });

  it('sin teclas de arma no se pide ninguna ranura', () => {
    expect(input.consume().slot).toBe(0);
  });

  it('con varias pulsadas gana la de menor numero', () => {
    key('keydown', 'Digit4');
    key('keydown', 'Digit2');
    expect(input.consume().slot).toBe(2);
  });

  /**
   * El bug que fija este test: antes el cambio de arma era un ciclo, asi que
   * mantener la tecla (o la repeticion automatica del teclado) encadenaba
   * cambios y se acababa con un arma que nadie habia pedido. Pedir una ranura
   * es idempotente: repetirla no puede llevar a otra arma.
   */
  it('mantener la tecla repite la misma peticion, no la siguiente', () => {
    key('keydown', 'Digit2');
    expect(input.consume().slot).toBe(2);
    expect(input.consume().slot).toBe(2);

    key('keyup', 'Digit2');
    expect(input.consume().slot).toBe(0);
  });
});

describe('teclado', () => {
  it('traduce las teclas a botones del comando', () => {
    key('keydown', 'KeyW');
    key('keydown', 'KeyD');
    key('keydown', 'Space');

    const state = input.consume();
    expect(state.buttons & BUTTON.FORWARD).toBeTruthy();
    expect(state.buttons & BUTTON.RIGHT).toBeTruthy();
    expect(state.buttons & BUTTON.JUMP).toBeTruthy();
    expect(state.buttons & BUTTON.LEFT).toBeFalsy();
  });

  it('soltar una tecla la retira del comando', () => {
    key('keydown', 'KeyW');
    key('keyup', 'KeyW');
    expect(input.consume().buttons & BUTTON.FORWARD).toBeFalsy();
  });

  it('acepta las teclas alternativas del mismo enlace', () => {
    key('keydown', 'ArrowUp');
    expect(input.consume().buttons & BUTTON.FORWARD).toBeTruthy();
  });

  it('perder el foco suelta todas las teclas', () => {
    key('keydown', 'KeyW');
    key('keydown', 'KeyA');
    window.dispatchEvent(new Event('blur'));
    expect(input.consume().buttons).toBe(0);
  });
});

describe('raton', () => {
  it('el boton izquierdo dispara', () => {
    element.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(input.consume().buttons & BUTTON.ATTACK).toBeTruthy();

    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    expect(input.consume().buttons & BUTTON.ATTACK).toBeFalsy();
  });

  it('sin captura del puntero no se gira la vista', () => {
    mouseMove(100, 50);
    const state = input.consume();
    expect(state.yaw).toBe(0);
    expect(state.pitch).toBe(0);
  });

  it('acumula todo el movimiento recibido entre dos ticks', () => {
    lock();
    // Un raton de alta frecuencia envia muchos eventos por fotograma: si solo
    // se leyera el ultimo, la mitad del giro se perderia.
    for (let i = 0; i < 10; i++) mouseMove(10, 0);
    const once = input.consume().yaw;

    input.setView(0, 0);
    mouseMove(100, 0);
    expect(input.consume().yaw).toBeCloseTo(once, 9);
  });

  it('mover a la derecha reduce el yaw (giro horario)', () => {
    lock();
    mouseMove(50, 0);
    expect(input.consume().yaw).toBeLessThan(0);
  });

  it('la sensibilidad escala el giro de forma proporcional', () => {
    lock();
    input.sensitivity = 1;
    mouseMove(100, 0);
    const slow = Math.abs(input.consume().yaw);

    input.setView(0, 0);
    input.sensitivity = 3;
    mouseMove(100, 0);
    expect(Math.abs(input.consume().yaw)).toBeCloseTo(slow * 3, 6);
  });

  it('el cabeceo se limita para no dar la vuelta de campana', () => {
    lock();
    mouseMove(0, 100000);
    expect(input.consume().pitch).toBe(MAX_PITCH);

    mouseMove(0, -1000000);
    expect(input.consume().pitch).toBe(-MAX_PITCH);
  });

  it('invertir el eje vertical cambia el sentido', () => {
    lock();
    mouseMove(0, 50);
    const normal = input.consume().pitch;

    input.setView(0, 0);
    input.invertY = true;
    mouseMove(0, 50);
    expect(input.consume().pitch).toBeCloseTo(-normal, 9);
  });

  it('el yaw se mantiene envuelto en el rango [-180, 180)', () => {
    lock();
    for (let i = 0; i < 50; i++) mouseMove(500, 0);
    const { yaw } = input.consume();
    expect(yaw).toBeGreaterThanOrEqual(-180);
    expect(yaw).toBeLessThan(180);
  });
});

describe('captura del puntero', () => {
  it('avisa de los cambios de estado', () => {
    const changes: boolean[] = [];
    input.onLockChange = (locked) => changes.push(locked);

    lock();
    expect(changes).toEqual([true]);

    Object.defineProperty(document, 'pointerLockElement', {
      value: null,
      configurable: true,
    });
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(changes).toEqual([true, false]);
  });

  it('perder la captura suelta las teclas pulsadas', () => {
    lock();
    key('keydown', 'KeyW');

    Object.defineProperty(document, 'pointerLockElement', {
      value: null,
      configurable: true,
    });
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(input.consume().buttons).toBe(0);
  });
});

describe('setView', () => {
  it('fija la vista y descarta el movimiento pendiente', () => {
    lock();
    mouseMove(500, 500);
    input.setView(90, 10);

    const state = input.consume();
    expect(state.yaw).toBe(90);
    expect(state.pitch).toBe(10);
  });

  it('acota el cabeceo indicado', () => {
    input.setView(0, 500);
    expect(input.consume().pitch).toBe(MAX_PITCH);
  });
});

describe('detach', () => {
  it('deja de escuchar eventos', () => {
    input.detach();
    key('keydown', 'KeyW');
    expect(input.consume().buttons).toBe(0);
  });
});
