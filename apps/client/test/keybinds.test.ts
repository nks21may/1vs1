/**
 * Nombres de tecla del panel de ajustes.
 *
 * Los `KeyboardEvent.code` no se pueden enseñar tal cual: nadie reconoce su
 * tecla en `ControlLeft` ni en `Digit1`.
 */

import { describe, expect, it } from 'vitest';

import { keyLabel } from '../src/keybinds.js';

describe('keyLabel', () => {
  it('las letras y los numeros se quedan en lo que dice la tecla', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit1')).toBe('1');
    expect(keyLabel('Numpad3')).toBe('Num 3');
  });

  it('las que no se leen solas tienen nombre propio', () => {
    expect(keyLabel('Space')).toBe('Espacio');
    expect(keyLabel('ControlLeft')).toBe('Ctrl izq');
    expect(keyLabel('ArrowUp')).toBe('↑');
  });

  it('sin tecla asignada se ve que no hay ninguna', () => {
    expect(keyLabel('')).toBe('—');
  });

  it('una tecla rara se enseña tal cual antes que no enseñar nada', () => {
    expect(keyLabel('IntlBackslash')).toBe('IntlBackslash');
    expect(keyLabel('F5')).toBe('F5');
  });
});
