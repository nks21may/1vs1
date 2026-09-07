/**
 * Ajustes del jugador, persistidos en el navegador.
 *
 * Se validan al leerlos: un `localStorage` manipulado (o de una version
 * anterior) no debe poder colar un FOV de 400 grados ni un `NaN` en la
 * sensibilidad, que se propagaria a los angulos de vista.
 */

import {
  BINDABLE_ACTIONS,
  DEFAULT_BINDINGS,
  MAX_KEYS_PER_ACTION,
  type InputBindings,
} from './input.js';

/** Aspecto de la mira. */
export interface CrosshairSettings {
  /** Color en hexadecimal `#rrggbb`. */
  color: string;
  /** Grosor de los trazos, en pixeles. */
  thickness: number;
  /**
   * Si se abre con la dispersion real del arma. La dinamica es informacion
   * honesta sobre donde puede acabar la bala; la estatica tapa menos pantalla y
   * hay quien prefiere leer la dispersion de memoria.
   */
  dynamic: boolean;
}

export interface Settings {
  name: string;
  /** Sensibilidad al estilo de Source (misma escala que `sensitivity` en CS). */
  sensitivity: number;
  invertY: boolean;
  /** Campo de vision vertical, en grados. */
  fov: number;
  /** Efecto de brillo; se puede desactivar en equipos modestos. */
  bloom: boolean;
  volume: number;
  showNetGraph: boolean;
  /**
   * Aviso sonoro que anticipa el aterrizaje para encadenar saltos. Es opcional
   * porque suena en cada caida y hay quien prefiere el ritmo a oido.
   */
  bhopCue: boolean;
  crosshair: CrosshairSettings;
  /** Teclas del jugador. Las que no toque se quedan como salen de fabrica. */
  bindings: InputBindings;
}

export const DEFAULT_SETTINGS: Settings = {
  name: 'JUGADOR',
  sensitivity: 2,
  invertY: false,
  fov: 74,
  bloom: true,
  volume: 0.6,
  showNetGraph: true,
  bhopCue: true,
  crosshair: { color: '#2ce8ff', thickness: 2, dynamic: true },
  bindings: DEFAULT_BINDINGS,
};

const STORAGE_KEY = 'neonduel.settings.v1';

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/**
 * Un codigo de tecla de los que da el navegador (`KeyboardEvent.code`).
 *
 * No hay lista cerrada --los teclados traen teclas para todo-- asi que se
 * comprueba la forma: letras y digitos, nada de cadenas arbitrarias que luego
 * acabarian pintadas en la interfaz.
 */
const isKeyCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,23}$/.test(value);

const asKeys = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return [...fallback];
  const keys = value.filter(isKeyCode).slice(0, MAX_KEYS_PER_ACTION);
  // Una lista vacia es valida: el jugador puede dejar una accion sin tecla.
  return [...new Set(keys)];
};

const sanitizeBindings = (raw: unknown): InputBindings => {
  const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const bindings = { slots: [] as string[][] } as InputBindings;
  for (const action of BINDABLE_ACTIONS) {
    bindings[action] = asKeys(data[action], DEFAULT_BINDINGS[action]);
  }

  const slots = Array.isArray(data.slots) ? data.slots : [];
  bindings.slots = DEFAULT_BINDINGS.slots.map((fallback, index) => asKeys(slots[index], fallback));
  return bindings;
};

/** `#rrggbb`, que es lo unico que emite un `<input type="color">`. */
const asColor = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;

const sanitizeCrosshair = (raw: unknown): CrosshairSettings => {
  const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    color: asColor(data.color, DEFAULT_SETTINGS.crosshair.color),
    thickness: clampNumber(data.thickness, 1, 6, DEFAULT_SETTINGS.crosshair.thickness),
    dynamic: asBoolean(data.dynamic, DEFAULT_SETTINGS.crosshair.dynamic),
  };
};

/** Normaliza cualquier objeto a unos ajustes validos. */
export const sanitizeSettings = (raw: unknown): Settings => {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const data = raw as Record<string, unknown>;

  const name =
    typeof data.name === 'string' && data.name.trim()
      ? data.name.trim().slice(0, 16)
      : DEFAULT_SETTINGS.name;

  return {
    name,
    sensitivity: clampNumber(data.sensitivity, 0.1, 20, DEFAULT_SETTINGS.sensitivity),
    invertY: asBoolean(data.invertY, DEFAULT_SETTINGS.invertY),
    fov: clampNumber(data.fov, 60, 110, DEFAULT_SETTINGS.fov),
    bloom: asBoolean(data.bloom, DEFAULT_SETTINGS.bloom),
    volume: clampNumber(data.volume, 0, 1, DEFAULT_SETTINGS.volume),
    showNetGraph: asBoolean(data.showNetGraph, DEFAULT_SETTINGS.showNetGraph),
    bhopCue: asBoolean(data.bhopCue, DEFAULT_SETTINGS.bhopCue),
    crosshair: sanitizeCrosshair(data.crosshair),
    bindings: sanitizeBindings(data.bindings),
  };
};

/** En un entorno sin DOM (los tests en Node, o el modo quiosco) no existe. */
const defaultStorage = (): Storage | undefined =>
  (globalThis as { localStorage?: Storage }).localStorage;

export const loadSettings = (storage: Storage | undefined = defaultStorage()): Settings => {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    // Modo privado o almacenamiento bloqueado: se juega con los valores por defecto.
    return { ...DEFAULT_SETTINGS };
  }
};

export const saveSettings = (
  settings: Settings,
  storage: Storage | undefined = defaultStorage(),
): void => {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
  } catch {
    // Persistir es un extra: si falla, la partida sigue igual.
  }
};
