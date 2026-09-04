/**
 * Arranque del cliente: menu, ajustes y ciclo de vida de la partida.
 *
 * Toda la logica de juego vive en `Game`; aqui solo se conecta la interfaz de
 * HTML con ella.
 */

import './style.css';

import { Game } from './game/game.js';
import { renderStatsRows, type StatsRow } from './hud.js';
import type { ConnectionStatus } from './game/net.js';
import { loadSettings, saveSettings, type Settings } from './game/settings.js';

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Falta el elemento: ${id}`);
  return element as T;
};

const canvas = byId<HTMLCanvasElement>('viewport');
const menu = byId('menu');
const pause = byId('pause');
const menuStatus = byId('menu-status');
const menuForm = byId<HTMLFormElement>('menu-form');
const nameInput = byId<HTMLInputElement>('name-input');
const playOnline = byId<HTMLButtonElement>('play-online');
const playBot = byId<HTMLButtonElement>('play-bot');
const difficulty = byId<HTMLFieldSetElement>('difficulty');
const resumeButton = byId<HTMLButtonElement>('resume');
const leaveButton = byId<HTMLButtonElement>('leave');
const summary = byId<HTMLElement>('summary');
const summaryTitle = byId<HTMLElement>('summary-title');
const summaryRows = byId<HTMLElement>('summary-rows');
const summaryClose = byId<HTMLButtonElement>('summary-close');

const controls = {
  sensitivity: byId<HTMLInputElement>('sensitivity'),
  fov: byId<HTMLInputElement>('fov'),
  volume: byId<HTMLInputElement>('volume'),
  invertY: byId<HTMLInputElement>('invert-y'),
  bloom: byId<HTMLInputElement>('bloom'),
  netgraph: byId<HTMLInputElement>('netgraph-toggle'),
};

const labels = {
  sensitivity: byId('sensitivity-label'),
  fov: byId('fov-label'),
  volume: byId('volume-label'),
};

let settings: Settings = loadSettings();
let game: Game | null = null;
let inMatch = false;

// --- Ajustes ---

const syncControls = (): void => {
  nameInput.value = settings.name;
  controls.sensitivity.value = String(settings.sensitivity);
  controls.fov.value = String(settings.fov);
  controls.volume.value = String(settings.volume);
  controls.invertY.checked = settings.invertY;
  controls.bloom.checked = settings.bloom;
  controls.netgraph.checked = settings.showNetGraph;

  labels.sensitivity.textContent = settings.sensitivity.toFixed(2);
  labels.fov.textContent = String(Math.round(settings.fov));
  labels.volume.textContent = `${Math.round(settings.volume * 100)}%`;
};

const updateSettings = (patch: Partial<Settings>): void => {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  syncControls();
  game?.applySettings(settings);
};

controls.sensitivity.addEventListener('input', () => {
  updateSettings({ sensitivity: Number(controls.sensitivity.value) });
});
controls.fov.addEventListener('input', () => {
  updateSettings({ fov: Number(controls.fov.value) });
});
controls.volume.addEventListener('input', () => {
  updateSettings({ volume: Number(controls.volume.value) });
});
controls.invertY.addEventListener('change', () => {
  updateSettings({ invertY: controls.invertY.checked });
});
controls.bloom.addEventListener('change', () => {
  updateSettings({ bloom: controls.bloom.checked });
});
controls.netgraph.addEventListener('change', () => {
  updateSettings({ showNetGraph: controls.netgraph.checked });
});
nameInput.addEventListener('change', () => {
  updateSettings({ name: nameInput.value.trim() || 'JUGADOR' });
});

syncControls();

// --- Estado de la interfaz ---

const setStatusMessage = (text: string, isError = false): void => {
  menuStatus.textContent = text;
  menuStatus.classList.toggle('is-error', isError);
};

const showMenu = (): void => {
  menu.hidden = false;
  pause.hidden = true;
  summary.hidden = true;
  document.body.classList.remove('playing');
};

const showSummary = (won: boolean, rows: StatsRow[]): void => {
  summaryTitle.textContent = won ? 'VICTORIA' : 'DERROTA';
  renderStatsRows(summaryRows, rows);
  summary.hidden = false;
  pause.hidden = true;
  document.body.classList.remove('playing');
  // Soltar el raton para poder pulsar el boton; el juego ya ha terminado.
  if (document.pointerLockElement) document.exitPointerLock();
};

const showPause = (): void => {
  pause.hidden = false;
  document.body.classList.remove('playing');
};

const hideOverlays = (): void => {
  menu.hidden = true;
  pause.hidden = true;
  summary.hidden = true;
  document.body.classList.add('playing');
};

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  idle: '',
  connecting: 'Conectando con el servidor...',
  connected: 'Conectado. Esperando rival...',
  closed: 'Conexión cerrada.',
  error: 'No se pudo conectar. ¿Está el servidor en marcha?',
};

const startMatch = (bot: string | null): void => {
  updateSettings({ name: nameInput.value.trim() || 'JUGADOR' });

  if (!game) {
    game = new Game(canvas, settings, {
      onStatus: (status, detail) => {
        const text = detail ?? STATUS_TEXT[status];
        if (status === 'error' || status === 'closed') {
          if (inMatch) {
            endMatch();
            setStatusMessage(text, true);
          }
        } else {
          setStatusMessage(text);
        }
      },
      onLockChange: (locked) => {
        if (!inMatch) return;
        // Con el resumen en pantalla la partida ya ha acabado: soltar el raton
        // no es una pausa, y sacar el panel de pausa encima taparia los numeros.
        if (!summary.hidden) return;
        if (locked) hideOverlays();
        else showPause();
      },
      onMatchEnd: (won, rows) => {
        // Se deja ver el ultimo momento de la partida y luego el resumen. No se
        // vuelve solo al menu: quien acaba de jugar querra leer los numeros.
        setTimeout(() => {
          if (inMatch) showSummary(won, rows);
        }, 3500);
      },
    });
  }

  game.applySettings(settings);
  inMatch = true;
  hideOverlays();
  game.start(bot);
  game.requestPointerLock();
};

const endMatch = (): void => {
  inMatch = false;
  game?.stop();
  showMenu();
};

menuForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startMatch(null);
});

playBot.addEventListener('click', () => {
  const skill =
    difficulty.querySelector<HTMLInputElement>('input[name="skill"]:checked')?.value ?? 'normal';
  startMatch(skill);
});

resumeButton.addEventListener('click', () => {
  game?.requestPointerLock();
});

summaryClose.addEventListener('click', () => {
  endMatch();
  setStatusMessage('Partida terminada.');
});

leaveButton.addEventListener('click', () => {
  endMatch();
  setStatusMessage('');
});

// Volver a capturar el ratón haciendo clic en el lienzo tras perder el foco.
canvas.addEventListener('click', () => {
  if (inMatch && pause.hidden === false) game?.requestPointerLock();
});

// Evita cerrar la pestaña por accidente en mitad de un duelo.
window.addEventListener('beforeunload', (event) => {
  if (!inMatch) return;
  event.preventDefault();
});

playOnline.disabled = false;
setStatusMessage('');
