/**
 * Controlador del HUD.
 *
 * Solo toca el DOM: no decide nada del juego. La mira se abre exactamente con
 * la dispersion real del arma (convertida de grados a pixeles con el FOV
 * actual), asi que lo que se ve en pantalla es informacion honesta sobre donde
 * puede acabar la bala, no un adorno.
 */

import { MAX_HEALTH, clamp } from '@neonduel/shared';

import type { CrosshairSettings } from './game/settings.js';

/**
 * Separacion de la mira estatica, en pixeles. Es la misma que trae el CSS: sin
 * dispersion que seguir, la mira se queda como esta en reposo.
 */
const STATIC_GAP_PX = 6;

import type { MatchPhase } from '@neonduel/shared';

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Falta el elemento del HUD: ${id}`);
  return element;
};

/** Una linea del marcador, ya formateada por quien sabe de la partida. */
export interface StatsRow {
  name: string;
  score: number;
  kills: number;
  deaths: number;
  /** Punteria en [0, 1]. */
  accuracy: number;
  /** Si es el jugador local, para poder distinguirlo de un vistazo. */
  self: boolean;
}

/**
 * Pinta las filas del marcador. Se rehace entero en cada apertura: son dos
 * filas, y reconciliar el DOM por tan poco solo daria formas de equivocarse.
 */
export const renderStatsRows = (tbody: HTMLElement, rows: StatsRow[]): void => {
  tbody.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement('tr');
      tr.className = row.self ? 'stats-row--self' : 'stats-row--enemy';
      const celdas = [
        row.name,
        String(row.score),
        String(row.kills),
        String(row.deaths),
        `${Math.round(row.accuracy * 100)}%`,
      ];
      celdas.forEach((texto, i) => {
        const td = document.createElement('td');
        if (i === 0) td.className = 'stats-name';
        td.textContent = texto;
        tr.append(td);
      });
      return tr;
    }),
  );
};

const PHASE_LABELS: Record<MatchPhase, string> = {
  waiting: 'ESPERANDO RIVAL',
  warmup: 'CALENTAMIENTO',
  freeze: 'PREPARADOS',
  live: 'EN JUEGO',
  roundEnd: 'FIN DE RONDA',
  matchEnd: 'FIN DE PARTIDA',
};

const formatTime = (seconds: number): string => {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
};

export class Hud {
  private readonly root = byId('hud');
  private readonly crosshair = byId('crosshair');
  private readonly hitmarker = byId('hitmarker');
  private readonly vignette = byId('damage-vignette');
  private readonly healthValue = byId('health-value');
  private readonly healthFill = byId('health-bar-fill');
  private readonly ammoValue = byId('ammo-value');
  private readonly weaponName = byId('weapon-name');
  private readonly reloadBar = byId('reload-bar');
  private readonly reloadFill = byId('reload-bar-fill');
  private readonly speedValue = byId('speed-value');
  private readonly speedFill = byId('speed-bar-fill');
  private readonly scoreSelf = byId('score-self');
  private readonly scoreEnemy = byId('score-enemy');
  private readonly nameSelf = byId('score-name-self');
  private readonly nameEnemy = byId('score-name-enemy');
  private readonly roundTimer = byId('round-timer');
  private readonly roundPhase = byId('round-phase');
  private readonly announcement = byId('announcement');
  private readonly killfeed = byId('killfeed');
  private readonly netgraph = byId('netgraph');
  private readonly netPing = byId('net-ping');
  private readonly netFps = byId('net-fps');
  private readonly statsPanel = byId('stats-panel');
  private readonly statsRows = byId('stats-rows');

  private hitmarkerTimer: ReturnType<typeof setTimeout> | null = null;
  private announcementTimer: ReturnType<typeof setTimeout> | null = null;
  private crosshairDynamic = true;
  private vignetteTimer: ReturnType<typeof setTimeout> | null = null;

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setNetGraphVisible(visible: boolean): void {
    this.netgraph.hidden = !visible;
  }

  /**
   * Abre la mira segun la dispersion del arma.
   * `spreadDegrees` es el radio del cono; se proyecta a pixeles con el FOV
   * vertical y la altura del lienzo.
   */
  /** Color, grosor y si la mira sigue a la dispersion o se queda quieta. */
  setCrosshair(crosshair: CrosshairSettings): void {
    this.crosshairDynamic = crosshair.dynamic;
    this.crosshair.style.setProperty('--color', crosshair.color);
    this.crosshair.style.setProperty('--thick', `${crosshair.thickness}px`);
    if (!crosshair.dynamic) this.crosshair.style.setProperty('--gap', `${STATIC_GAP_PX}px`);
  }

  setSpread(spreadDegrees: number, fovDegrees: number, viewportHeight: number): void {
    if (!this.crosshairDynamic) return;
    const halfFov = Math.tan((fovDegrees * Math.PI) / 360);
    const pixels = (Math.tan((spreadDegrees * Math.PI) / 180) / halfFov) * (viewportHeight / 2);
    this.crosshair.style.setProperty('--gap', `${clamp(pixels, 3, 220).toFixed(1)}px`);
  }

  setHealth(health: number): void {
    const critical = health <= 30;
    this.healthValue.textContent = String(Math.max(0, Math.round(health)));
    this.healthValue.classList.toggle('is-critical', critical);
    this.healthFill.style.transform = `scaleX(${clamp(health / MAX_HEALTH, 0, 1)})`;
    this.healthFill.classList.toggle('is-critical', critical);
  }

  /**
   * Arma y municion. Un cargador de cero balas es un arma cuerpo a cuerpo: no
   * gasta nada, asi que mostrar un "0" en rojo mentiria diciendo que esta
   * vacia y que hay que recargarla.
   */
  setWeapon(name: string, ammo: number, magazine: number, reload: number): void {
    const melee = magazine === 0;
    this.weaponName.textContent = name;
    this.ammoValue.textContent = melee ? '∞' : String(ammo);
    this.ammoValue.classList.toggle('is-empty', !melee && ammo === 0);

    const reloading = reload > 0;
    this.reloadBar.hidden = !reloading;
    if (reloading) this.reloadFill.style.transform = `scaleX(${clamp(reload, 0, 1)})`;
  }

  setSpeed(speed: number, maxSpeed: number): void {
    this.speedValue.textContent = String(Math.round(speed));
    // La barra llega al maximo con el tope de carrera; correr mas (bunnyhop)
    // la desborda a proposito, para que se note que se ha ganado velocidad.
    this.speedFill.style.transform = `scaleX(${clamp(speed / maxSpeed, 0, 1.4)})`;
  }

  /** Muestra u oculta el marcador completo (Tab). */
  showStats(visible: boolean): void {
    this.statsPanel.hidden = !visible;
  }

  setStats(rows: StatsRow[]): void {
    renderStatsRows(this.statsRows, rows);
  }

  setScore(selfName: string, selfScore: number, enemyName: string, enemyScore: number): void {
    this.nameSelf.textContent = selfName;
    this.nameEnemy.textContent = enemyName;
    this.scoreSelf.textContent = String(selfScore);
    this.scoreEnemy.textContent = String(enemyScore);
  }

  setPhase(phase: MatchPhase, remaining: number): void {
    this.roundPhase.textContent = PHASE_LABELS[phase];
    this.roundTimer.textContent = formatTime(remaining);
  }

  /** Mensaje grande y breve en el centro de la pantalla. */
  announce(text: string, kind: 'neutral' | 'win' | 'lose' = 'neutral', ms = 2200): void {
    this.announcement.textContent = text;
    this.announcement.classList.toggle('is-win', kind === 'win');
    this.announcement.classList.toggle('is-lose', kind === 'lose');
    this.announcement.classList.add('is-visible');

    if (this.announcementTimer) clearTimeout(this.announcementTimer);
    this.announcementTimer = setTimeout(() => {
      this.announcement.classList.remove('is-visible');
    }, ms);
  }

  clearAnnouncement(): void {
    if (this.announcementTimer) clearTimeout(this.announcementTimer);
    this.announcement.classList.remove('is-visible');
  }

  addKill(killer: string, victim: string, headshot: boolean): void {
    const item = document.createElement('li');

    const killerEl = document.createElement('span');
    killerEl.className = 'feed-killer';
    killerEl.textContent = killer;

    const icon = document.createElement('span');
    icon.className = headshot ? 'feed-headshot' : 'feed-icon';
    icon.textContent = headshot ? '⊙' : '›';

    const victimEl = document.createElement('span');
    victimEl.className = 'feed-victim';
    victimEl.textContent = victim;

    item.append(killerEl, icon, victimEl);
    this.killfeed.prepend(item);

    while (this.killfeed.children.length > 4) this.killfeed.lastElementChild?.remove();
    setTimeout(() => item.remove(), 6000);
  }

  clearKillfeed(): void {
    this.killfeed.replaceChildren();
  }

  showHitmarker(kill = false): void {
    this.hitmarker.classList.toggle('is-kill', kill);
    this.hitmarker.classList.remove('is-fading');
    this.hitmarker.classList.add('is-visible');

    if (this.hitmarkerTimer) clearTimeout(this.hitmarkerTimer);
    this.hitmarkerTimer = setTimeout(
      () => {
        this.hitmarker.classList.add('is-fading');
        this.hitmarker.classList.remove('is-visible');
      },
      kill ? 220 : 90,
    );
  }

  flashDamage(intensity = 1): void {
    this.vignette.style.opacity = String(clamp(intensity, 0, 1));
    if (this.vignetteTimer) clearTimeout(this.vignetteTimer);
    this.vignetteTimer = setTimeout(() => {
      this.vignette.style.opacity = '0';
    }, 120);
  }

  setNet(ping: number, fps: number): void {
    this.netPing.textContent = `${Math.round(ping)} ms`;
    this.netPing.classList.toggle('is-bad', ping > 120);
    this.netFps.textContent = `${Math.round(fps)} fps`;
    this.netFps.classList.toggle('is-bad', fps < 50);
  }
}
