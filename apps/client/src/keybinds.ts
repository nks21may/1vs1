/**
 * Panel de teclas de los ajustes.
 *
 * Solo toca el DOM: la logica de que tecla va donde vive en
 * [input.ts](game/input.ts), que es donde se usa. Aqui se dibujan las filas, se
 * captura la siguiente pulsacion y se avisa del cambio.
 */

import { WEAPON_SLOTS, getWeapon } from '@neonduel/shared';

import {
  BINDABLE_ACTIONS,
  MAX_KEYS_PER_ACTION,
  assignKey,
  clearKey,
  type BindableAction,
  type InputBindings,
  type KeySlot,
} from './game/input.js';

/** Teclas cuyo `code` no se lee solo. El resto se deduce por su prefijo. */
const KEY_NAMES: Record<string, string> = {
  Space: 'Espacio',
  Tab: 'Tab',
  Enter: 'Intro',
  Backspace: 'Retroceso',
  CapsLock: 'Bloq Mayús',
  ControlLeft: 'Ctrl izq',
  ControlRight: 'Ctrl der',
  ShiftLeft: 'Mayús izq',
  ShiftRight: 'Mayús der',
  AltLeft: 'Alt izq',
  AltRight: 'Alt der',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** Nombre legible de un `KeyboardEvent.code`. */
export const keyLabel = (code: string): string => {
  if (!code) return '—';
  const named = KEY_NAMES[code];
  if (named !== undefined) return named;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
};

const ACTION_LABELS: Record<BindableAction, string> = {
  forward: 'Adelante',
  back: 'Atrás',
  left: 'Izquierda',
  right: 'Derecha',
  jump: 'Saltar',
  duck: 'Agacharse',
  walk: 'Andar',
  reload: 'Recargar',
  stats: 'Marcador',
};

const rows = (bindings: InputBindings): { action: BindableAction | number; label: string }[] => [
  ...BINDABLE_ACTIONS.map((action) => ({ action, label: ACTION_LABELS[action] })),
  ...bindings.slots.map((_, index) => ({
    action: index,
    label: getWeapon(WEAPON_SLOTS[index] ?? 'rifle').name,
  })),
];

const keysOf = (bindings: InputBindings, action: BindableAction | number): string[] =>
  typeof action === 'number' ? (bindings.slots[action] ?? []) : bindings[action];

/**
 * Dibuja el panel y devuelve una funcion para redibujarlo.
 *
 * Mientras se espera una tecla, la captura se hace en fase de captura y con
 * `preventDefault`: si no, asignar el tabulador movería el foco y asignar la
 * barra espaciadora pulsaría el propio boton.
 */
export const mountKeybinds = (
  root: HTMLElement,
  read: () => InputBindings,
  write: (bindings: InputBindings) => void,
): (() => void) => {
  let capturing: KeySlot | null = null;
  let cancelCapture: (() => void) | null = null;

  const render = (): void => {
    const bindings = read();
    root.replaceChildren();

    for (const { action, label } of rows(bindings)) {
      const row = document.createElement('div');
      row.className = 'keybind-row';

      const name = document.createElement('span');
      name.className = 'keybind-name';
      name.textContent = label;
      row.append(name);

      const keys = keysOf(bindings, action);
      for (let index = 0; index < MAX_KEYS_PER_ACTION; index++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'keybind-key';
        button.textContent = keyLabel(keys[index] ?? '');
        const slot: KeySlot = { action, index };
        button.addEventListener('click', () => startCapture(slot, button));
        row.append(button);
      }

      root.append(row);
    }
  };

  const startCapture = (slot: KeySlot, button: HTMLButtonElement): void => {
    cancelCapture?.();
    capturing = slot;
    button.classList.add('is-capturing');
    button.textContent = 'Pulsa…';

    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      finish();
      if (capturing === null) return;

      const slotToWrite = capturing;
      capturing = null;
      if (event.code === 'Escape') {
        render();
        return;
      }
      // Retroceso y suprimir dejan la accion sin esa tecla, que es la unica
      // forma de quitar una sin poner otra.
      const isClear = event.code === 'Backspace' || event.code === 'Delete';
      write(isClear ? clearKey(read(), slotToWrite) : assignKey(read(), slotToWrite, event.code));
      render();
    };

    const finish = (): void => {
      window.removeEventListener('keydown', onKeyDown, true);
      cancelCapture = null;
    };

    cancelCapture = (): void => {
      finish();
      capturing = null;
      render();
    };

    window.addEventListener('keydown', onKeyDown, true);
  };

  render();
  return render;
};
