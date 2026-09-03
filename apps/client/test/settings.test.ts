import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  loadSettings,
  sanitizeSettings,
  saveSettings,
} from '../src/game/settings.js';

/** Almacenamiento en memoria con el interfaz de `Storage`. */
const memoryStorage = (initial: Record<string, string> = {}): Storage => {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  } as Storage;
};

/** Almacenamiento que falla siempre, como en modo privado. */
const brokenStorage = (): Storage =>
  ({
    getItem() {
      throw new Error('bloqueado');
    },
    setItem() {
      throw new Error('bloqueado');
    },
  }) as unknown as Storage;

describe('sanitizeSettings', () => {
  it('acepta unos ajustes validos tal cual', () => {
    const valid = { ...DEFAULT_SETTINGS, sensitivity: 3.5, fov: 100 };
    expect(sanitizeSettings(valid)).toEqual(valid);
  });

  it('sustituye los valores no numericos por los de fabrica', () => {
    const result = sanitizeSettings({ sensitivity: 'mucha', fov: null, volume: NaN });
    expect(result.sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
    expect(result.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(result.volume).toBe(DEFAULT_SETTINGS.volume);
  });

  it('acota los valores fuera de rango', () => {
    const high = sanitizeSettings({ sensitivity: 9999, fov: 400, volume: 12 });
    expect(high.sensitivity).toBe(20);
    expect(high.fov).toBe(110);
    expect(high.volume).toBe(1);

    const low = sanitizeSettings({ sensitivity: -5, fov: 1, volume: -3 });
    expect(low.sensitivity).toBe(0.1);
    expect(low.fov).toBe(60);
    expect(low.volume).toBe(0);
  });

  it('recorta el nombre y descarta el vacio', () => {
    expect(sanitizeSettings({ name: '   ESPACIOS   ' }).name).toBe('ESPACIOS');
    expect(sanitizeSettings({ name: 'X'.repeat(40) }).name).toHaveLength(16);
    expect(sanitizeSettings({ name: '  ' }).name).toBe(DEFAULT_SETTINGS.name);
    expect(sanitizeSettings({ name: 42 }).name).toBe(DEFAULT_SETTINGS.name);
  });

  it('los valores no booleanos vuelven a su defecto', () => {
    const result = sanitizeSettings({ bloom: 'si', invertY: 1 });
    expect(result.bloom).toBe(DEFAULT_SETTINGS.bloom);
    expect(result.invertY).toBe(DEFAULT_SETTINGS.invertY);
  });

  it('entradas absurdas devuelven los ajustes de fabrica', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('cadena')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('persistencia', () => {
  it('guarda y recupera los ajustes', () => {
    const storage = memoryStorage();
    const settings = { ...DEFAULT_SETTINGS, name: 'NEO', fov: 95, bloom: false };

    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('sin nada guardado devuelve los de fabrica', () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('un almacenamiento corrupto no rompe el arranque', () => {
    const storage = memoryStorage({ 'neonduel.settings.v1': '{roto' });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('valores manipulados a mano se sanean al cargar', () => {
    const storage = memoryStorage({
      'neonduel.settings.v1': JSON.stringify({ fov: 500, sensitivity: -1 }),
    });
    const loaded = loadSettings(storage);
    expect(loaded.fov).toBe(110);
    expect(loaded.sensitivity).toBe(0.1);
  });

  it('si el almacenamiento falla se juega igual', () => {
    expect(loadSettings(brokenStorage())).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS, brokenStorage())).not.toThrow();
  });

  it('sin almacenamiento disponible tampoco falla', () => {
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS, undefined)).not.toThrow();
  });
});
