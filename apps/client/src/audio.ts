/**
 * Sonido sintetizado con la Web Audio API.
 *
 * No hay ni un archivo de audio: todo son osciladores, ruido y filtros. Ademas
 * de mantener el juego en unos pocos kilobytes, permite variar cada disparo
 * ligeramente y que una rafaga no suene a bucle repetido.
 *
 * El contexto solo se crea tras un gesto del usuario, como exigen los
 * navegadores; hasta entonces todas las llamadas son inocuas.
 */

import { type Vec3, vec3 } from '@neonduel/shared';

import { listenerVectors, toAudioCoords } from './spatial.js';

/** Coloca un nodo espacial, por los dos caminos que existen segun navegador. */
const setNodePosition = (node: PannerNode, v: Vec3): void => {
  if (node.positionX) {
    node.positionX.value = v.x;
    node.positionY.value = v.y;
    node.positionZ.value = v.z;
    return;
  }
  node.setPosition?.(v.x, v.y, v.z);
};

const distanceBetween = (a: Vec3, b: Vec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export type SoundName =
  | 'rifle'
  | 'pistol'
  | 'sniper'
  | 'impact'
  | 'hit'
  | 'headshot'
  | 'step'
  | 'jump'
  | 'land'
  | 'reload'
  | 'death'
  | 'roundStart'
  | 'win'
  | 'lose';

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private volume = 0.6;
  /** Ultima posicion del oyente, para medir la distancia de cada sonido. */
  private listenerPos: Vec3 = vec3();

  /** Crea el contexto. Debe llamarse desde un gesto del usuario. */
  init(): void {
    if (this.context) {
      void this.context.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    this.context = new Ctor();
    this.master = this.context.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.context.destination);

    // Un segundo de ruido blanco reutilizable: la base de disparos y pasos.
    const length = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master) this.master.gain.value = this.volume;
  }

  /**
   * Coloca y orienta al oyente. Sin esto el `PannerNode` situaria todos los
   * sonidos respecto a un oyente en el origen mirando a -Z, y girarse no
   * cambiaria de que lado suenan las cosas.
   */
  setListener(position: Vec3, yawDeg: number, pitchDeg: number): void {
    const ctx = this.context;
    if (!ctx) return;

    this.listenerPos = position;
    const pos = toAudioCoords(position);
    const { forward, up } = listenerVectors(yawDeg, pitchDeg);
    const listener = ctx.listener;

    // Los navegadores viejos solo tienen los metodos, y los nuevos solo los
    // AudioParam; hay que soportar los dos caminos.
    if (listener.positionX) {
      listener.positionX.value = pos.x;
      listener.positionY.value = pos.y;
      listener.positionZ.value = pos.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
      return;
    }
    listener.setPosition?.(pos.x, pos.y, pos.z);
    listener.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }

  /**
   * Reproduce un sonido. Si se le da una posicion del mundo, suena situado ahi:
   * atenuado por la distancia y, sobre todo, viniendo de su lado. Sin posicion
   * suena plano, que es lo que quieren los avisos y el arma propia.
   */
  play(name: SoundName, at?: Vec3): void {
    const ctx = this.context;
    const master = this.master;
    if (!ctx || !master) return;

    const gain = ctx.createGain();
    // Atenuacion suave: audible en todo el mapa, pero claramente lejano.
    const distance = at ? distanceBetween(this.listenerPos, at) : 0;
    gain.gain.value = 1 / (1 + distance / 900);

    if (at) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      // El panner solo situa; la atenuacion por distancia la sigue haciendo el
      // gain de arriba con la curva de siempre. Con `rolloffFactor` a cero el
      // panner no toca el volumen, asi que anadir direccion no cambia de paso
      // el equilibrio de volumenes que ya estaba ajustado.
      panner.distanceModel = 'inverse';
      panner.rolloffFactor = 0;
      setNodePosition(panner, toAudioCoords(at));
      gain.connect(panner).connect(master);
    } else {
      gain.connect(master);
    }

    const now = ctx.currentTime;
    switch (name) {
      case 'rifle':
        this.gunshot(gain, now, {
          sub: 48, body: 82, crack: 1400, duration: 0.34, level: 0.46, punch: 0.42, weight: 1,
          tail: 1.6,
        });
        break;
      case 'sniper':
        // Mas grave y mas larga que el rifle: un disparo que se oye en todo el
        // mapa y que delata al tirador durante un buen rato.
        this.gunshot(gain, now, {
          sub: 38, body: 68, crack: 1150, duration: 0.55, level: 0.5, punch: 0.62, weight: 1.15,
          tail: 2.1,
        });
        break;

      case 'pistol':
        // Mas seca que el rifle: apenas sub, cuerpo mas alto y cola corta. No es
        // el mismo disparo mas agudo, es otro golpe.
        this.gunshot(gain, now, {
          sub: 70, body: 200, crack: 2000, duration: 0.19, level: 0.64, punch: 0.2, weight: 0.5,
          tail: 0.9,
        });
        break;
      case 'impact':
        this.noise(gain, now, { duration: 0.09, frequency: 1800, q: 2, level: 0.3 });
        break;
      case 'hit':
        this.blip(gain, now, 880, 0.06, 0.28);
        break;
      case 'headshot':
        this.blip(gain, now, 1400, 0.05, 0.32);
        this.blip(gain, now + 0.05, 2100, 0.07, 0.28);
        break;
      case 'step':
        this.noise(gain, now, { duration: 0.06, frequency: 420, q: 1.2, level: 0.16 });
        break;
      case 'jump':
        this.blip(gain, now, 320, 0.07, 0.14, 'triangle');
        break;
      case 'land':
        this.noise(gain, now, { duration: 0.11, frequency: 220, q: 1, level: 0.22 });
        break;
      case 'reload':
        this.noise(gain, now, { duration: 0.05, frequency: 900, q: 3, level: 0.2 });
        this.noise(gain, now + 0.16, { duration: 0.05, frequency: 1300, q: 3, level: 0.2 });
        break;
      case 'death':
        this.sweep(gain, now, 420, 60, 0.6, 0.3);
        break;
      case 'roundStart':
        this.blip(gain, now, 520, 0.09, 0.22, 'square');
        this.blip(gain, now + 0.12, 780, 0.12, 0.22, 'square');
        break;
      case 'win':
        this.blip(gain, now, 660, 0.1, 0.25, 'triangle');
        this.blip(gain, now + 0.11, 880, 0.1, 0.25, 'triangle');
        this.blip(gain, now + 0.22, 1180, 0.22, 0.25, 'triangle');
        break;
      case 'lose':
        this.sweep(gain, now, 400, 120, 0.7, 0.25);
        break;
    }
  }

  /**
   * Disparo: golpe sub-grave, cuerpo percusivo, chasquido de boca y cola, todo
   * por un paso bajo cuya frecuencia cae. Ese barrido descendente es lo que da
   * la sensacion de aire desplazado: sin el queda un chasquido pelado.
   */
  private gunshot(
    destination: GainNode,
    now: number,
    options: {
      sub: number;
      body: number;
      crack: number;
      duration: number;
      level: number;
      /** Peso del sub: junto a `weight`, lo que separa al rifle de la pistola. */
      punch: number;
      /** Peso del cuerpo. Bajarlo seca el disparo y deja mandar al chasquido. */
      weight: number;
      /** Cuanto se alarga la cola respecto a la duracion del cuerpo. */
      tail: number;
    },
  ): void {
    const ctx = this.context!;
    // Variacion aleatoria por disparo: una rafaga no suena a copia y pega.
    const detune = 0.92 + Math.random() * 0.16;

    const bus = ctx.createBiquadFilter();
    bus.type = 'lowpass';
    bus.frequency.setValueAtTime(7200, now);
    bus.frequency.exponentialRampToValueAtTime(options.crack * 0.62, now + options.duration);
    bus.connect(destination);

    // 1. Sub: el golpe en el pecho. Corto a proposito, porque alargarlo
    //    emborrona la rafaga entera en cuanto se disparan tres seguidos.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(options.sub * detune, now);
    sub.frequency.exponentialRampToValueAtTime(options.sub * 0.62, now + 0.09);
    const subGain = ctx.createGain();
    // El sub es la capa mas tonal y la que mas se delata al repetirse, asi que
    // su peso tambien varia y no solo su afinacion.
    const punch = options.punch * (0.8 + Math.random() * 0.4);
    subGain.gain.setValueAtTime(options.level * punch, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    sub.connect(subGain).connect(bus);
    sub.start(now);
    sub.stop(now + 0.13);

    // 2. Cuerpo. Diente de sierra y no seno a proposito: sus armonicos son los
    //    que hacen que el disparo se siga leyendo en un portatil, donde el sub
    //    no existe. Si esto fuera un seno, con altavoces pequenos no quedaria
    //    casi nada del disparo.
    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(options.body * detune, now);
    body.frequency.exponentialRampToValueAtTime(options.body * 0.4, now + options.duration * 0.6);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(options.level * options.weight, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + options.duration * 0.8);
    body.connect(bodyGain).connect(bus);
    body.start(now);
    body.stop(now + options.duration);

    // 3. Chasquido de la boca. Acompana al golpe en lugar de mandar: en cuanto
    //    sube por encima del cuerpo, el disparo suena fino por muy grave que
    //    sea todo lo demas.
    this.noise(bus, now, {
      duration: options.duration * 0.5,
      frequency: options.crack * detune,
      q: 0.7,
      level: options.level * 0.78,
      highpass: true,
    });

    // 4. Cola: el eco del disparo alejandose. Muy por debajo del resto; lo que
    //    aporta es duracion, no volumen.
    this.noise(bus, now + 0.01, {
      duration: options.duration * options.tail,
      frequency: options.crack * 0.38,
      q: 0.6,
      level: options.level * 0.26,
    });
  }

  private noise(
    destination: AudioNode,
    now: number,
    options: {
      duration: number;
      frequency: number;
      q: number;
      level: number;
      highpass?: boolean;
    },
  ): void {
    const ctx = this.context!;
    if (!this.noiseBuffer) return;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    // Arranque aleatorio dentro del buffer: mas variedad sin mas memoria.
    const offset = Math.random() * 0.5;

    const filter = ctx.createBiquadFilter();
    filter.type = options.highpass ? 'highpass' : 'bandpass';
    filter.frequency.value = options.frequency;
    filter.Q.value = options.q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(options.level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + options.duration);

    source.connect(filter).connect(gain).connect(destination);
    source.start(now, offset, options.duration + 0.05);
    source.stop(now + options.duration + 0.05);
  }

  private blip(
    destination: GainNode,
    now: number,
    frequency: number,
    duration: number,
    level: number,
    type: OscillatorType = 'sine',
  ): void {
    const ctx = this.context!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain).connect(destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  private sweep(
    destination: GainNode,
    now: number,
    from: number,
    to: number,
    duration: number,
    level: number,
  ): void {
    const ctx = this.context!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, now);
    filter.frequency.exponentialRampToValueAtTime(200, now + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(filter).connect(gain).connect(destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }
}
