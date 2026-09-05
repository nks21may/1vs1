import { describe, expect, it } from 'vitest';

import { BUTTON, MAX_HEALTH, TICK_DT } from '../src/constants.js';
import { length2D, vec3 } from '../src/math.js';
import {
  applyDamage,
  canFire,
  createPlayer,
  respawnPlayer,
  simulatePlayerTick,
} from '../src/player.js';
import { KNIFE, PISTOL, RIFLE, SNIPER } from '../src/weapons.js';
import { cmd, flatWorld, slotCmd } from './helpers.js';

const world = flatWorld();

const newPlayer = () => createPlayer(1, 'TEST', vec3(0, 0, 1));

/** Ejecuta `ticks` comandos y devuelve todos los eventos generados. */
const run = (player: ReturnType<typeof newPlayer>, ticks: number, buttons: number, yaw = 0) => {
  const events = [];
  for (let i = 0; i < ticks; i++) {
    events.push(simulatePlayerTick(player, cmd(buttons, yaw), world));
  }
  return events;
};

describe('disparo', () => {
  it('el rifle dispara en automatico a su cadencia', () => {
    const player = newPlayer();
    const seconds = 1;
    const events = run(player, Math.round(seconds / TICK_DT), BUTTON.ATTACK);
    const shots = events.filter((e) => e.shot).length;
    // 1 segundo a 0.1 s por bala: 10 disparos (mas o menos uno por el redondeo).
    expect(shots).toBeGreaterThanOrEqual(9);
    expect(shots).toBeLessThanOrEqual(11);
  });

  it('la pistola exige soltar el gatillo entre disparos', () => {
    const player = newPlayer();
    simulatePlayerTick(player, slotCmd(2), world);
    expect(player.weapon).toBe('pistol');
    // El cambio de arma impone una espera antes del primer disparo.
    run(player, 32, 0);

    const events = run(player, 64, BUTTON.ATTACK);
    expect(events.filter((e) => e.shot).length).toBe(1);
  });

  it('mantener el gatillo durante el cambio de arma no dispara al terminar', () => {
    const player = newPlayer();
    simulatePlayerTick(player, slotCmd(2), world);
    const events = run(player, 64, BUTTON.ATTACK);
    expect(events.filter((e) => e.shot).length).toBe(0);
  });

  it('consume munición y recarga sola al vaciar el cargador', () => {
    const player = newPlayer();
    // Cada bala ocupa ceil(cycleTime / TICK_DT) ticks, no cycleTime exacto.
    const ticksPerShot = Math.ceil(RIFLE.cycleTime / TICK_DT);
    run(player, RIFLE.magazine * (ticksPerShot + 1) + 4, BUTTON.ATTACK);
    expect(player.ammo.rifle).toBe(0);
    expect(player.reloadRemaining).toBeGreaterThan(0);
  });

  it('la recarga rellena el cargador al terminar', () => {
    const player = newPlayer();
    player.ammo.rifle = 5;
    const events = run(player, Math.ceil(RIFLE.reloadTime / TICK_DT) + 2, BUTTON.RELOAD);
    expect(events.some((e) => e.startedReload)).toBe(true);
    expect(events.some((e) => e.finishedReload)).toBe(true);
    expect(player.ammo.rifle).toBe(RIFLE.magazine);
  });

  it('no se puede disparar mientras se recarga', () => {
    const player = newPlayer();
    player.ammo.rifle = 1;
    simulatePlayerTick(player, cmd(BUTTON.RELOAD), world);
    expect(canFire(player)).toBe(false);
  });

  it('un muerto no dispara', () => {
    const player = newPlayer();
    player.alive = false;
    const events = run(player, 10, BUTTON.ATTACK);
    expect(events.every((e) => e.shot === null)).toBe(true);
  });

  it('el indice del patron avanza y se reinicia tras la pausa', () => {
    const player = newPlayer();
    run(player, 32, BUTTON.ATTACK);
    expect(player.shotIndex).toBeGreaterThan(1);

    run(player, Math.ceil(RIFLE.recoilResetTime / TICK_DT) + 2, 0);
    expect(player.shotIndex).toBe(0);
  });

  it('cada disparo usa una semilla distinta', () => {
    const player = newPlayer();
    const events = run(player, 64, BUTTON.ATTACK);
    const seeds = events.filter((e) => e.shot).map((e) => e.shot!.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('el disparo sale de la altura de los ojos', () => {
    const player = newPlayer();
    const events = run(player, 2, BUTTON.ATTACK);
    const shot = events.find((e) => e.shot)?.shot;
    expect(shot).toBeDefined();
    expect(shot!.origin.z).toBeGreaterThan(player.pos.z + 50);
  });
});

describe('cambio de arma', () => {
  it('cada ranura lleva siempre a la misma arma', () => {
    const player = newPlayer();
    const esperado = [
      [2, 'pistol'],
      [3, 'knife'],
      [4, 'sniper'],
      [1, 'rifle'],
    ] as const;

    for (const [slot, arma] of esperado) {
      simulatePlayerTick(player, slotCmd(slot), world);
      expect(player.weapon).toBe(arma);
    }
  });

  it('mantener la tecla pulsada no encadena cambios', () => {
    const player = newPlayer();
    const events = [];
    for (let i = 0; i < 32; i++) {
      events.push(simulatePlayerTick(player, slotCmd(3), world));
    }
    expect(player.weapon).toBe('knife');
    expect(events.filter((e) => e.switchedWeapon)).toHaveLength(1);
  });

  it('pedir el arma que ya se lleva no cuesta nada', () => {
    const player = newPlayer();
    const events = simulatePlayerTick(player, slotCmd(1), world);
    expect(events.switchedWeapon).toBe(false);
    expect(canFire(player)).toBe(true);
  });

  it('una ranura que no existe se ignora', () => {
    const player = newPlayer();
    simulatePlayerTick(player, slotCmd(9), world);
    expect(player.weapon).toBe('rifle');
  });

  it('cambiar de arma impone un tiempo antes de poder disparar', () => {
    const player = newPlayer();
    simulatePlayerTick(player, slotCmd(2), world);
    expect(canFire(player)).toBe(false);
  });

  it('la pistola permite moverse mas rapido que el rifle', () => {
    expect(PISTOL.speedMultiplier).toBeGreaterThan(RIFLE.speedMultiplier);
  });
});

describe('cuchillo', () => {
  /** Deja al jugador con el cuchillo y pasado el tiempo de sacarlo. */
  const conCuchillo = () => {
    const player = newPlayer();
    simulatePlayerTick(player, slotCmd(3), world);
    run(player, 32, 0);
    return player;
  };

  it('es el arma con la que mas se corre', () => {
    for (const arma of [RIFLE, PISTOL, SNIPER]) {
      expect(KNIFE.speedMultiplier).toBeGreaterThan(arma.speedMultiplier);
    }
  });

  it('sacarlo se nota en la velocidad, no solo en la ficha del arma', () => {
    const correr = (slot: number) => {
      const player = newPlayer();
      simulatePlayerTick(player, slotCmd(slot), world);
      run(player, 96, BUTTON.FORWARD);
      return length2D(player.vel);
    };
    expect(correr(3)).toBeGreaterThan(correr(2) * 1.1);
  });

  it('no gasta municion ni se queda nunca sin balas', () => {
    const player = conCuchillo();
    const events = [];
    for (let i = 0; i < 256; i++) {
      // Semiautomatico: hay que soltar el boton entre tajos.
      events.push(simulatePlayerTick(player, cmd(i % 2 === 0 ? BUTTON.ATTACK : 0), world));
    }

    expect(events.filter((e) => e.shot).length).toBeGreaterThan(5);
    expect(events.some((e) => e.emptyClick)).toBe(false);
    expect(events.some((e) => e.startedReload)).toBe(false);
    expect(player.ammo.knife).toBe(0);
  });

  it('la tecla de recarga no hace nada con el cuchillo', () => {
    const player = conCuchillo();
    const events = simulatePlayerTick(player, cmd(BUTTON.RELOAD), world);
    expect(events.startedReload).toBe(false);
    expect(player.reloadRemaining).toBe(0);
  });

  it('solo alcanza a quemarropa', () => {
    expect(KNIFE.range).toBeLessThan(PISTOL.range / 10);
  });
});

describe('dano', () => {
  it('resta vida y no mata mientras quede salud', () => {
    const player = newPlayer();
    expect(applyDamage(player, 40)).toBe(false);
    expect(player.health).toBe(MAX_HEALTH - 40);
    expect(player.alive).toBe(true);
  });

  it('marca la muerte y deja la vida en cero', () => {
    const player = newPlayer();
    expect(applyDamage(player, 150)).toBe(true);
    expect(player.health).toBe(0);
    expect(player.alive).toBe(false);
  });

  it('un jugador muerto no recibe mas dano', () => {
    const player = newPlayer();
    applyDamage(player, 150);
    expect(applyDamage(player, 50)).toBe(false);
  });
});

describe('respawnPlayer', () => {
  it('restaura vida, munición y postura', () => {
    const player = newPlayer();
    applyDamage(player, 60);
    player.ammo.rifle = 3;
    player.ducking = true;
    player.weapon = 'pistol';

    respawnPlayer(player, vec3(100, 200, 8), 90);

    expect(player.health).toBe(MAX_HEALTH);
    expect(player.alive).toBe(true);
    expect(player.ammo.rifle).toBe(RIFLE.magazine);
    expect(player.ducking).toBe(false);
    expect(player.weapon).toBe('rifle');
    expect(player.pos).toEqual(vec3(100, 200, 8));
    expect(player.yaw).toBe(90);
  });
});

describe('determinismo de la simulacion completa', () => {
  it('reproducir los mismos comandos da el mismo estado', () => {
    const commands = Array.from({ length: 200 }, (_, i) => ({
      seq: i,
      buttons: (i % 5 === 0 ? BUTTON.JUMP : 0) | BUTTON.FORWARD | (i % 3 === 0 ? BUTTON.ATTACK : 0),
      yaw: Math.sin(i / 10) * 40,
      pitch: Math.cos(i / 13) * 10,
      dt: TICK_DT,
    }));

    const simulate = () => {
      const player = createPlayer(1, 'A', vec3(0, 0, 1));
      const shots: number[] = [];
      for (const command of commands) {
        const events = simulatePlayerTick(player, command, world);
        if (events.shot) shots.push(events.shot.seed);
      }
      return { player, shots };
    };

    const a = simulate();
    const b = simulate();
    expect(a.player.pos).toEqual(b.player.pos);
    expect(a.player.vel).toEqual(b.player.vel);
    expect(a.player.ammo).toEqual(b.player.ammo);
    expect(a.shots).toEqual(b.shots);
  });
});

describe('apuntado con mira', () => {
  it('el boton de apuntar entra en el estado del jugador', () => {
    const player = newPlayer();
    player.weapon = 'sniper';

    simulatePlayerTick(player, cmd(BUTTON.AIM), world);
    expect(player.aiming).toBe(true);

    simulatePlayerTick(player, cmd(0), world);
    expect(player.aiming).toBe(false);
  });

  it('con un arma sin mira, apuntar no hace nada', () => {
    const player = newPlayer();
    simulatePlayerTick(player, cmd(BUTTON.AIM), world);
    expect(player.weapon).toBe('rifle');
    expect(player.aiming).toBe(false);
  });

  it('cambiar a un arma sin mira cancela el apuntado', () => {
    const player = newPlayer();
    player.weapon = 'sniper';
    simulatePlayerTick(player, cmd(BUTTON.AIM), world);
    expect(player.aiming).toBe(true);

    // Sigue pulsando apuntar mientras cambia de arma.
    simulatePlayerTick(player, slotCmd(1, BUTTON.AIM), world);
    expect(player.weapon).toBe('rifle');
    expect(player.aiming).toBe(false);
  });

  it('apuntar frena al jugador', () => {
    const correr = (aiming: boolean) => {
      const player = newPlayer();
      player.weapon = 'sniper';
      player.pos = vec3(0, 0, 0);
      run(player, 96, BUTTON.FORWARD | (aiming ? BUTTON.AIM : 0));
      return length2D(player.vel);
    };

    expect(correr(true)).toBeLessThan(correr(false) * 0.6);
  });
});
