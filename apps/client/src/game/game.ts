/**
 * Orquestador del cliente.
 *
 * Separa dos ritmos: la simulacion avanza a pasos fijos de 1/64 s (los mismos
 * que el servidor, o la prediccion no coincidiria) y el dibujado va libre a la
 * frecuencia de la pantalla. Entre ambos, la interpolacion suaviza al rival.
 */

import { Group, Vector3 } from 'three';

import {
  BHOP_CUE_LEAD,
  BHOP_CUE_MIN_SPEED,
  type CollisionWorld,
  DEFAULT_MAP,
  type GameMap,
  INTERP_DELAY_MS,
  type MatchPhase,
  type PlayerSnapshot,
  type SnapshotMessage,
  TICK_DT,
  type UserCommand,
  type Vec3,
  type WeaponDef,
  advanceFootstep,
  createCollisionWorld,
  accuracy,
  applyPhaseRestrictions,
  computeSpread,
  createFootstepTracker,
  createPlayer,
  eyePosition,
  getRecoil,
  getMap,
  getWeapon,
  length2D,
  maxSpeedFor,
  weaponSpeedMultiplier,
  shotDirection,
  timeToLanding,
  traceHitscan,
  vec3,
} from '@neonduel/shared';

import { AudioEngine } from '../audio.js';
import { Hud } from '../hud.js';
import { EffectSystem } from '../render/effects.js';
import { AvatarManager } from '../render/players.js';
import { PALETTE, applyViewAngles, createRenderContext, toThree } from '../render/scene.js';
import { ViewModel } from '../render/viewmodel.js';
import { buildWorldMesh, disposeWorldMesh } from '../render/world.js';
import { InterpolationBuffer, type InterpolatedPlayer } from './interpolation.js';
import { type DeathCamera, createDeathCamera, updateDeathCamera } from './deathcam.js';
import { InputManager } from './input.js';
import { NetClient, type ConnectionStatus, buildServerUrl } from './net.js';
import { PredictionSystem } from './prediction.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';
import type { StatsRow } from '../hud.js';

export interface GameCallbacks {
  onStatus(status: ConnectionStatus, detail?: string): void;
  onLockChange(locked: boolean): void;
  onMatchEnd(won: boolean, rows: StatsRow[]): void;
}

export class Game {
  private readonly render;
  private readonly hud = new Hud();
  private readonly audio = new AudioEngine();
  private readonly input: InputManager;
  private readonly net: NetClient;
  private readonly effects = new EffectSystem();
  private readonly viewModel = new ViewModel();
  private readonly avatars: AvatarManager;
  private readonly interpolation = new InterpolationBuffer(INTERP_DELAY_MS);
  /**
   * Mapa en juego. Lo fija el `welcome` del servidor: el cliente no lo elige,
   * lo pide. Si prediccion y servidor no simularan la misma geometria, el
   * jugador atravesaria paredes en su pantalla y volveria de golpe.
   */
  private map: GameMap = DEFAULT_MAP;
  private world: CollisionWorld = createCollisionWorld(DEFAULT_MAP);
  private worldMesh: Group | null = null;
  private readonly entityGroup = new Group();

  private prediction: PredictionSystem | null = null;
  private localId = -1;
  private sequence = 0;
  private accumulator = 0;
  private lastFrame = 0;
  private running = false;
  private frameHandle = 0;

  private phase: MatchPhase = 'waiting';
  private phaseRemaining = 0;
  /** True entre que se cae el socket y se vuelve, para avisar de las dos cosas. */
  private reconnecting = false;
  private remotePlayers: InterpolatedPlayer[] = [];
  private latestSnapshot: SnapshotMessage | null = null;

  // Retroceso visual de la camara: sigue al patron del arma solo en parte, de
  // modo que compensar el spray sigue siendo cosa del jugador.
  private punchPitch = 0;
  private punchYaw = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private readonly footsteps = createFootstepTracker();
  /**
   * Si queda aviso de bhop pendiente en este salto. Se rearma al pisar suelo,
   * de modo que suena una vez por caida y no en cada tick del descenso.
   */
  private bhopCueArmed = false;
  /** Camara de muerte mientras el jugador local esta muerto. */
  private deathCam: DeathCamera | null = null;
  /** FOV actual de la camara, que se mueve al apuntar. */
  private fov = DEFAULT_SETTINGS.fov;
  private fps = 60;
  private settings: Settings;

  constructor(
    canvas: HTMLCanvasElement,
    settings: Settings,
    private readonly callbacks: GameCallbacks,
  ) {
    this.settings = settings;
    this.render = createRenderContext(canvas);
    this.input = new InputManager(canvas);
    this.avatars = new AvatarManager(this.entityGroup);

    this.setMap(DEFAULT_MAP);
    this.render.scene.add(this.entityGroup);
    this.render.scene.add(this.effects.group);
    this.render.camera.add(this.viewModel.root);
    this.render.scene.add(this.render.camera);

    this.net = new NetClient({
      onWelcome: (message) => {
        this.localId = message.playerId;
        // El mapa lo manda el servidor, no lo decide el cliente: si el nombre
        // no se reconoce se sigue con el de por defecto, que es lo que el
        // servidor tambien hace con un parametro que no entiende.
        const mapa = getMap(message.mapName);
        if (mapa && mapa !== this.map) this.setMap(mapa);
      },
      onSnapshot: (message, receivedAt) => this.onSnapshot(message, receivedAt),
      onStatus: (status, detail) => {
        // Reconectar pasa con el menu oculto: sin decirlo en el HUD, el jugador
        // solo ve el mundo congelado y no sabe si esperar o volver al menu.
        if (status === 'connecting' && detail) {
          this.reconnecting = true;
          this.hud.announce(detail, 'neutral', 1500);
        } else if (status === 'connected' && this.reconnecting) {
          this.reconnecting = false;
          this.hud.announce('DE VUELTA');
        }
        this.callbacks.onStatus(status, detail);
      },
    });

    this.input.onLockChange = (locked) => this.callbacks.onLockChange(locked);
    this.applySettings(settings);
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.input.sensitivity = settings.sensitivity;
    this.input.invertY = settings.invertY;
    // Cambiar el ajuste con la mira puesta no debe tirar del zoom: solo se
    // salta al valor nuevo si no se esta apuntando.
    if (!this.prediction?.player.aiming) this.fov = settings.fov;
    this.render.setFov(this.fov);
    this.render.setBloomEnabled(settings.bloom);
    this.audio.setVolume(settings.volume);
    this.hud.setNetGraphVisible(settings.showNetGraph);
  }

  /** Conecta y arranca el bucle. `bot` selecciona partida de practica. */
  start(bot: string | null, map?: string | null): void {
    this.audio.init();
    this.input.attach();
    this.hud.setVisible(true);
    this.hud.clearKillfeed();
    this.resize();

    this.net.connect(buildServerUrl(bot, map), this.settings.name);

    this.running = true;
    this.lastFrame = performance.now();
    this.accumulator = 0;
    this.frameHandle = requestAnimationFrame(this.frame);
    window.addEventListener('resize', this.resize);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('resize', this.resize);
    this.input.detach();
    this.input.releaseLock();
    this.net.disconnect();
    this.hud.setVisible(false);
    this.avatars.clear();
    this.interpolation.clear();
    this.prediction = null;
    this.localId = -1;
  }

  requestPointerLock(): void {
    this.audio.init();
    this.input.requestLock();
  }

  private readonly resize = (): void => {
    this.render.setSize(window.innerWidth, window.innerHeight);
  };

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.frame);

    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    // Media movil: un contador de FPS que parpadee cada frame es ilegible.
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.08;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 5) {
      this.accumulator -= TICK_DT;
      this.simulateTick();
      steps++;
    }
    // Si el navegador se ha quedado atras (pestana en segundo plano) se
    // descartan los ticks pendientes en vez de acelerarlos de golpe.
    if (this.accumulator > TICK_DT * 5) this.accumulator = 0;

    this.updateVisuals(dt, now);
    this.render.render();
  };

  /** Un paso de simulacion: leer entrada, predecir y enviar. */
  private simulateTick(): void {
    const prediction = this.prediction;
    if (!prediction || !this.net.isOpen) return;

    const state = this.input.consume();
    this.sequence += 1;

    const raw: UserCommand = {
      seq: this.sequence,
      buttons: state.buttons,
      yaw: state.yaw,
      pitch: state.pitch,
      dt: TICK_DT,
      slot: state.slot,
    };
    // El cliente aplica la misma restriccion de fase que el servidor; si no,
    // predeciria movimiento durante la congelacion y habria que corregirlo.
    const cmd = applyPhaseRestrictions(raw, this.phase !== 'live');

    const events = prediction.apply(cmd);
    this.net.sendCommand(raw);

    if (events.shot) {
      this.onLocalShot(events.shot.yaw, events.shot.pitch, events.shot.shotIndex);
    }
    // Dos sonidos distintos para el salto: el jugador sabe si encadeno sin
    // tener que mirar el marcador de velocidad.
    if (events.jumped) this.audio.play(events.bhop ? 'bhop' : 'jump');
    if (events.landed && events.landingSpeed > 200) this.audio.play('land');
    if (events.startedReload) this.audio.play('reload');
    if (events.switchedWeapon) this.audio.play('reload');

    // Recuperacion del retroceso visual.
    const weapon = getWeapon(prediction.player.weapon);
    const recovery = Math.exp(-weapon.viewPunchRecovery * TICK_DT);
    this.punchPitch *= recovery;
    this.punchYaw *= recovery;

    this.updateFootsteps(TICK_DT);
    this.updateBhopCue();
  }

  /**
   * Aviso anticipado para encadenar saltos.
   *
   * Suena *antes* de tocar suelo, no al aterrizar, y esa es toda la gracia: la
   * ventana de bhop dura 150 ms, asi que un aviso posterior solo serviria de
   * metronomo y no de senal a la que reaccionar. Con `BHOP_CUE_LEAD` de
   * antelacion, pulsar al oirlo cae dentro de la ventana.
   *
   * Vive en el cliente y no en la simulacion porque no cambia nada del juego:
   * es informacion, y se calcula sobre el jugador predicho para que llegue sin
   * el retraso de la red.
   */
  private updateBhopCue(): void {
    const player = this.prediction?.player;
    if (!player || !player.alive) return;

    if (player.onGround) {
      this.bhopCueArmed = true;
      return;
    }
    if (!this.bhopCueArmed || !this.settings.bhopCue) return;
    // Andando o cayendo despacio no hay cadena que mantener, y el aviso solo
    // seria un pitido mas en cada bordillo.
    if (length2D(player.vel) < BHOP_CUE_MIN_SPEED) return;

    const remaining = timeToLanding(player, this.world);
    if (remaining === null || remaining > BHOP_CUE_LEAD) return;

    this.audio.play('bhopCue');
    this.bhopCueArmed = false;
  }

  /** Efectos inmediatos del propio disparo, sin esperar al servidor. */
  private onLocalShot(yaw: number, pitch: number, shotIndex: number): void {
    const prediction = this.prediction!;
    const weapon = getWeapon(prediction.player.weapon);
    const origin = eyePosition(prediction.player);
    const dir = shotDirection(yaw, pitch);

    // Se predice contra el mundo y contra el rival interpolado: el trazador
    // termina donde el jugador ve que deberia terminar.
    const targets = this.remotePlayers
      .filter((p) => p.alive)
      .map((p) => ({ id: p.id, pos: p.pos, ducking: p.ducking }));
    const result = traceHitscan(this.world, targets, origin, dir, weapon.range);

    // El cuchillo no deja trazador: una raya de 76 unidades delante de la cara
    // no informa de nada y solo ensucia la pantalla.
    if (!weapon.melee) {
      this.effects.addTracer(this.muzzlePosition(origin, dir), result.endPos, weapon.tracerColor);
    }
    if (result.hitWorld) this.effects.addImpact(result.endPos, result.normal);

    this.audio.play(weapon.id);
    this.viewModel.punch(1);

    // El retroceso visual es una fraccion del patron: la mira sube menos que la
    // bala, y cerrar esa diferencia es la habilidad que se aprende.
    const current = getRecoil(weapon, shotIndex);
    const next = getRecoil(weapon, shotIndex + 1);
    this.punchPitch += (next.pitch - current.pitch) * weapon.viewPunchRatio;
    this.punchYaw += (next.yaw - current.yaw) * weapon.viewPunchRatio;
  }

  /** Punto de salida de la bala, algo por delante y a la derecha de la vista. */
  private muzzlePosition(origin: Vec3, dir: Vec3): Vec3 {
    return vec3(origin.x + dir.x * 24, origin.y + dir.y * 24, origin.z + dir.z * 24 - 4);
  }

  /**
   * Pasos propios. Se predicen en lugar de esperar al evento del servidor,
   * porque oir el propio paso con un viaje de ida y vuelta de retraso se nota
   * enseguida. Usa la misma regla que el servidor, asi que suenan cuando el
   * servidor los emite para los demas.
   */
  private updateFootsteps(dt: number): void {
    const prediction = this.prediction;
    if (!prediction || !prediction.player.alive) return;

    const player = prediction.player;
    if (advanceFootstep(this.footsteps, length2D(player.vel), player.onGround, dt)) {
      this.audio.play('step');
    }
  }

  /** Camara, avatares, efectos y HUD. */
  private updateVisuals(dt: number, now: number): void {
    const prediction = this.prediction;
    this.remotePlayers = this.interpolation.sample(now, this.localId);
    this.avatars.update(this.remotePlayers, dt, this.localId);
    this.effects.update(dt);

    if (!prediction) {
      this.render.camera.position.set(0, 400, 1400);
      this.render.camera.lookAt(new Vector3(0, 120, 0));
      return;
    }

    const player = prediction.player;
    // Volver a estar vivo la cancela, venga la reaparicion de donde venga.
    if (this.deathCam && player.alive) this.deathCam = null;
    const deathCam = this.deathCam;
    if (deathCam) {
      // Muerto: la vista deja de ser la del jugador y gira hacia el asesino.
      const snapshot = this.latestSnapshot;
      const killer =
        snapshot && deathCam.killerId !== null
          ? this.positionOf(snapshot, deathCam.killerId)
          : null;
      updateDeathCamera(deathCam, killer ?? null, dt);
      toThree(deathCam.eye, this.render.camera.position);
      applyViewAngles(this.render.camera, deathCam.yaw, deathCam.pitch);
      this.audio.setListener(deathCam.eye, deathCam.yaw, deathCam.pitch);
    } else {
      const eye = eyePosition(player);
      toThree(eye, this.render.camera.position);
      applyViewAngles(
        this.render.camera,
        player.yaw + this.punchYaw,
        player.pitch - this.punchPitch,
      );

      // El oyente va con la camara: sin el retroceso, que mueve la vista unos
      // grados y haria bailar la posicion de los sonidos sin motivo.
      this.audio.setListener(eye, player.yaw, player.pitch);
    }

    const weapon = getWeapon(player.weapon);
    const speed = length2D(player.vel);
    const maxSpeed = maxSpeedFor(0, player.ducking, weaponSpeedMultiplier(weapon, player.aiming));
    this.updateZoom(weapon, player.aiming, dt);

    this.viewModel.setWeapon(player.weapon);
    this.viewModel.update({
      dt,
      speed,
      maxSpeed,
      onGround: player.onGround,
      yawDelta: player.yaw - this.lastYaw,
      pitchDelta: player.pitch - this.lastPitch,
      reloading: player.reloadRemaining > 0 ? 1 - player.reloadRemaining / weapon.reloadTime : 0,
      alive: player.alive,
    });
    this.lastYaw = player.yaw;
    this.lastPitch = player.pitch;

    this.updateHud(player.health, speed, maxSpeed);
  }

  private updateHud(health: number, speed: number, maxSpeed: number): void {
    const prediction = this.prediction!;
    const player = prediction.player;
    const weapon = getWeapon(player.weapon);

    const spread = computeSpread(
      weapon,
      { speed, onGround: player.onGround, ducking: player.ducking, aiming: player.aiming },
      maxSpeed,
    );
    this.hud.setSpread(spread, this.fov, window.innerHeight);
    this.hud.setHealth(health);
    this.hud.setSpeed(speed, 250);
    this.hud.setWeapon(
      weapon.name,
      player.ammo[player.weapon],
      weapon.magazine,
      player.reloadRemaining > 0 ? 1 - player.reloadRemaining / weapon.reloadTime : 0,
    );
    this.hud.setPhase(this.phase, this.phaseRemaining);
    this.hud.setNet(this.net.rtt, this.fps);

    const snapshot = this.latestSnapshot;
    if (snapshot) {
      const self = snapshot.players.find((p) => p.id === this.localId);
      const enemy = snapshot.players.find((p) => p.id !== this.localId);
      this.hud.setScore(
        self?.name ?? 'TU',
        self?.score ?? 0,
        enemy?.name ?? 'RIVAL',
        enemy?.score ?? 0,
      );

      // El marcador se rellena solo mientras esta abierto: son dos filas, pero
      // no hay razon para tocar el DOM sesenta veces por segundo sin mirarlo.
      const showing = this.input.showingStats;
      this.hud.showStats(showing);
      if (showing) this.hud.setStats(this.statsRows(snapshot));
    }
  }

  /**
   * Acerca el FOV al del arma cuando se apunta y lo devuelve al soltar. El
   * zoom se suaviza solo para la vista: la simulacion ya considera que se
   * apunta desde el primer tick, asi que la precision no depende de la
   * animacion.
   */
  private updateZoom(weapon: WeaponDef, aiming: boolean, dt: number): void {
    const objetivo = aiming && weapon.aim ? weapon.aim.fov : this.settings.fov;
    this.fov += (objetivo - this.fov) * (1 - Math.exp(-18 * Math.min(dt, 1)));
    if (Math.abs(this.fov - objetivo) < 0.05) this.fov = objetivo;
    this.render.setFov(this.fov);
    // La sensibilidad sigue al zoom real y no al objetivo: durante la
    // transicion tambien tiene que responder a lo que se ve.
    this.input.setZoomFactor(this.fov / this.settings.fov);
  }

  /** Las filas del marcador, con el jugador local siempre el primero. */
  private statsRows(snapshot: SnapshotMessage): StatsRow[] {
    return [...snapshot.players]
      .sort((a, b) => Number(b.id === this.localId) - Number(a.id === this.localId))
      .map((player) => ({
        name: player.name,
        score: player.score,
        kills: player.stats.kills,
        deaths: player.stats.deaths,
        accuracy: accuracy(player.stats.hits, player.stats.shots),
        self: player.id === this.localId,
      }));
  }

  private onSnapshot(message: SnapshotMessage, receivedAt: number): void {
    this.latestSnapshot = message;
    this.phase = message.phase;
    this.phaseRemaining = message.phaseTime;
    this.interpolation.push(message.players, receivedAt);

    const self = message.players.find((p) => p.id === this.localId);
    if (self) {
      if (!this.prediction) this.initialisePrediction(self);
      else this.prediction.reconcile(self, message.ack);
    }

    this.handleEvents(message);

    // El servidor pide un giro (reaparicion o cambio de lado). Se aplica a la
    // entrada, que es la fuente del angulo: tocar solo al jugador predicho lo
    // desharia el siguiente comando.
    if (message.viewYaw !== undefined) {
      this.input.setView(message.viewYaw, 0);
      this.punchYaw = 0;
      this.punchPitch = 0;
    }
  }

  /** Cambia el mapa: rehace la malla y la geometria contra la que se predice. */
  private setMap(map: GameMap): void {
    this.map = map;
    this.world = createCollisionWorld(map);
    if (this.worldMesh) {
      this.render.scene.remove(this.worldMesh);
      disposeWorldMesh(this.worldMesh);
    }
    this.worldMesh = buildWorldMesh(map);
    this.render.scene.add(this.worldMesh);
  }

  private initialisePrediction(self: PlayerSnapshot): void {
    const player = createPlayer(self.id, self.name, vec3(self.x, self.y, self.z), self.yaw);
    this.prediction = new PredictionSystem(player, this.world);
    this.prediction.reset(self);
    this.input.setView(self.yaw, self.pitch);
    this.lastYaw = self.yaw;
    this.lastPitch = self.pitch;
  }

  private handleEvents(message: SnapshotMessage): void {
    for (const event of message.events) {
      switch (event.t) {
        case 'shot': {
          // Los disparos propios ya se dibujaron al predecirlos.
          if (event.local) break;
          const from = vec3(event.ox, event.oy, event.oz);
          const to = vec3(event.ex, event.ey, event.ez);
          const weapon = getWeapon(event.weapon);
          if (!weapon.melee) this.effects.addTracer(from, to, weapon.tracerColor);
          this.audio.play(event.weapon, from);
          break;
        }

        case 'impact':
          this.effects.addImpact(
            vec3(event.x, event.y, event.z),
            vec3(event.nx, event.ny, event.nz),
          );
          break;

        case 'hit': {
          const point = vec3(event.x, event.y, event.z);
          this.effects.addImpact(point, vec3(0, 0, 1), PALETTE.bloodImpact);
          if (event.attacker === this.localId) {
            this.hud.showHitmarker(false);
            this.audio.play(event.group === 'head' ? 'headshot' : 'hit');
          }
          if (event.victim === this.localId) {
            this.hud.flashDamage(Math.min(1, event.damage / 60));
          }
          break;
        }

        case 'death': {
          const victim = this.nameOf(message, event.victim);
          const killer = event.killer !== null ? this.nameOf(message, event.killer) : 'EL VACIO';
          this.hud.addKill(killer, victim, event.group === 'head');
          if (event.killer === this.localId) this.hud.showHitmarker(true);
          if (event.victim === this.localId && this.prediction) {
            // Arranca mirando donde miraba el jugador, para que el giro hacia
            // el asesino se vea salir de su propia vista y no aparezca de golpe.
            const self = this.prediction.player;
            this.deathCam = createDeathCamera(
              eyePosition(self),
              self.yaw,
              self.pitch,
              event.killer,
            );
          }
          // La muerte propia suena plana: es un aviso, no algo que pase en un
          // punto del mapa.
          this.audio.play(
            'death',
            event.victim === this.localId ? undefined : this.positionOf(message, event.victim),
          );
          break;
        }

        case 'jump':
        case 'land':
        case 'reload': {
          if (event.id === this.localId) break;
          // Sin posicion no se reproduce: sonaria plano y a todo volumen, que
          // enganaria mas que el silencio.
          const at = this.positionOf(message, event.id);
          if (at) this.audio.play(event.t, at);
          break;
        }

        case 'step':
          // Los pasos propios ya se han predicho arriba; este evento es lo que
          // convierte al rival en algo que se puede oir venir.
          if (event.id !== this.localId) {
            this.audio.play('step', vec3(event.x, event.y, event.z));
          }
          break;

        case 'roundStart':
          this.onRoundStart(message, event.round);
          break;

        case 'roundEnd': {
          if (event.winnerId === null) this.hud.announce('RONDA EMPATADA');
          else if (event.winnerId === this.localId) this.hud.announce('RONDA GANADA', 'win');
          else this.hud.announce('RONDA PERDIDA', 'lose');
          break;
        }

        case 'matchEnd': {
          const won = event.winnerId === this.localId;
          this.hud.announce(won ? 'VICTORIA' : 'DERROTA', won ? 'win' : 'lose', 6000);
          this.audio.play(won ? 'win' : 'lose');
          this.callbacks.onMatchEnd(won, this.statsRows(message));
          break;
        }

        default:
          break;
      }
    }
  }

  private onRoundStart(message: SnapshotMessage, round: number): void {
    const self = message.players.find((p) => p.id === this.localId);
    if (self && this.prediction) {
      // Reaparecer descarta la prediccion pendiente: el estado nuevo lo fija el
      // servidor, y arrastrar comandos de la ronda anterior daria un tiron.
      this.prediction.reset(self);
      this.sequence += 1;
    }
    this.punchPitch = 0;
    this.punchYaw = 0;
    // Sin esto la ronda nueva empezaria mirando al asesino de la anterior.
    this.deathCam = null;
    this.hud.announce(`RONDA ${round}`, 'neutral', 1600);
    this.audio.play('roundStart');
  }

  private nameOf(message: SnapshotMessage, id: number): string {
    return message.players.find((p) => p.id === id)?.name ?? 'JUGADOR';
  }

  /**
   * Donde esta un jugador segun la instantanea, o `undefined` si ya no esta en
   * la partida. Se usa la instantanea y no el avatar interpolado porque es la
   * posicion que el servidor da por buena para ese evento.
   */
  private positionOf(message: SnapshotMessage, id: number): Vec3 | undefined {
    const player = message.players.find((p) => p.id === id);
    return player ? vec3(player.x, player.y, player.z) : undefined;
  }
}
