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

export type SoundName =
  | 'rifle'
  | 'pistol'
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
   * Reproduce un sonido. `distance` atenua segun lo lejos que ocurra, en
   * unidades del juego: un disparo al otro lado del mapa debe oirse debil.
   */
  play(name: SoundName, distance = 0): void {
    const ctx = this.context;
    const master = this.master;
    if (!ctx || !master) return;

    const gain = ctx.createGain();
    // Atenuacion suave: audible en todo el mapa, pero claramente lejano.
    gain.gain.value = 1 / (1 + distance / 900);
    gain.connect(master);

    const now = ctx.currentTime;
    switch (name) {
      case 'rifle':
        this.gunshot(gain, now, { body: 150, crack: 2400, duration: 0.24, level: 0.55 });
        break;
      case 'pistol':
        this.gunshot(gain, now, { body: 260, crack: 3200, duration: 0.16, level: 0.42 });
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

  /** Disparo: cuerpo grave percusivo mas el chasquido agudo de la boca. */
  private gunshot(
    destination: GainNode,
    now: number,
    options: { body: number; crack: number; duration: number; level: number },
  ): void {
    const ctx = this.context!;

    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    // Variacion aleatoria por disparo: una rafaga no suena a copia y pega.
    const detune = 0.94 + Math.random() * 0.12;
    body.frequency.setValueAtTime(options.body * detune, now);
    body.frequency.exponentialRampToValueAtTime(options.body * 0.35, now + options.duration);

    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(options.level, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, now + options.duration);
    body.connect(bodyGain).connect(destination);
    body.start(now);
    body.stop(now + options.duration + 0.02);

    this.noise(destination, now, {
      duration: options.duration * 0.6,
      frequency: options.crack * detune,
      q: 0.8,
      level: options.level * 0.9,
      highpass: true,
    });
  }

  private noise(
    destination: GainNode,
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
