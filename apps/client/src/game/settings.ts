/**
 * Ajustes del jugador, persistidos en el navegador.
 *
 * Se validan al leerlos: un `localStorage` manipulado (o de una version
 * anterior) no debe poder colar un FOV de 400 grados ni un `NaN` en la
 * sensibilidad, que se propagaria a los angulos de vista.
 */

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
}

export const DEFAULT_SETTINGS: Settings = {
  name: 'JUGADOR',
  sensitivity: 2,
  invertY: false,
  fov: 74,
  bloom: true,
  volume: 0.6,
  showNetGraph: true,
};

const STORAGE_KEY = 'neonduel.settings.v1';

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

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
  };
};

export const loadSettings = (storage: Storage | undefined = globalThis.localStorage): Settings => {
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
  storage: Storage | undefined = globalThis.localStorage,
): void => {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
  } catch {
    // Persistir es un extra: si falla, la partida sigue igual.
  }
};
