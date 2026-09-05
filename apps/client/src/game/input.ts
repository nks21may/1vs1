/**
 * Entrada del jugador: teclado, raton y bloqueo de puntero.
 *
 * Acumula el movimiento del raton entre ticks en lugar de muestrear la posicion
 * final: asi un raton de 1000 Hz no pierde precision al generar comandos a 64 Hz.
 */

import { BUTTON, MAX_PITCH, clamp, normalizeAngle } from '@neonduel/shared';

export interface InputBindings {
  forward: string[];
  back: string[];
  left: string[];
  right: string[];
  jump: string[];
  duck: string[];
  walk: string[];
  reload: string[];
  /**
   * Una tecla por arma, en el orden de `WEAPON_SLOTS`. Es una lista de listas y
   * no un ciclo a proposito: con un ciclo, pulsar dos veces seguido (o que se
   * repita la pulsacion) cambiaba a un arma que nadie habia pedido.
   */
  slots: string[][];
  /** Abrir el marcador. Es solo del cliente: no viaja al servidor. */
  stats: string[];
}

const DEFAULT_BINDINGS: InputBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  duck: ['ControlLeft', 'KeyC'],
  walk: ['ShiftLeft'],
  reload: ['KeyR'],
  slots: [
    ['Digit1', 'Numpad1'],
    ['Digit2', 'Numpad2'],
    ['Digit3', 'Numpad3'],
    ['Digit4', 'Numpad4'],
  ],
  stats: ['Tab'],
};

/** Conversion de sensibilidad al estilo de Source: grados por unidad de raton. */
const YAW_PER_COUNT = 0.022;

export interface InputState {
  buttons: number;
  yaw: number;
  pitch: number;
  /** Ranura de arma pedida (1-based), o 0 si no se pide ninguna. */
  slot: number;
}

export class InputManager {
  private readonly pressed = new Set<string>();
  private mouseButtons = 0;
  private pendingYaw = 0;
  private pendingPitch = 0;

  yaw = 0;
  pitch = 0;
  sensitivity = 2;
  /** Escala de sensibilidad por el zoom; 1 sin apuntar. */
  private zoomFactor = 1;
  invertY = false;
  /** True mientras el puntero este capturado por el lienzo. */
  locked = false;

  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly bindings: InputBindings = DEFAULT_BINDINGS,
  ) {}

  attach(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    this.element.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    // Sin esto, el clic derecho abre el menu del navegador en mitad de un duelo.
    this.element.addEventListener('contextmenu', this.preventDefault);
  }

  detach(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.element.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    this.element.removeEventListener('contextmenu', this.preventDefault);
  }

  requestLock(): void {
    void this.element.requestPointerLock();
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  /** Fija la vista, por ejemplo al reaparecer mirando al centro del mapa. */
  setView(yaw: number, pitch: number): void {
    this.yaw = normalizeAngle(yaw);
    this.pitch = clamp(pitch, -MAX_PITCH, MAX_PITCH);
    this.pendingYaw = 0;
    this.pendingPitch = 0;
  }

  /**
   * Consume el movimiento acumulado del raton y devuelve el estado de entrada
   * para este tick.
   */
  consume(): InputState {
    // Al apuntar, el mismo movimiento de raton tiene que recorrer los mismos
    // pixeles de pantalla, no los mismos grados: sin escalar la sensibilidad
    // con el zoom, la mira se vuelve inmanejable justo cuando mas precision
    // hace falta.
    const sens = this.sensitivity * this.zoomFactor;
    this.yaw = normalizeAngle(this.yaw - this.pendingYaw * YAW_PER_COUNT * sens);
    const pitchDelta = this.pendingPitch * YAW_PER_COUNT * sens;
    this.pitch = clamp(
      this.pitch + (this.invertY ? -pitchDelta : pitchDelta),
      -MAX_PITCH,
      MAX_PITCH,
    );
    this.pendingYaw = 0;
    this.pendingPitch = 0;

    return {
      buttons: this.buttons(),
      yaw: this.yaw,
      pitch: this.pitch,
      slot: this.slot(),
    };
  }

  /**
   * Ranura pedida este tick. Con varias teclas a la vez gana la de menor numero:
   * hace falta *alguna* regla y esta es la unica que no depende del orden en que
   * el navegador haya entregado los eventos.
   */
  private slot(): number {
    const index = this.bindings.slots.findIndex((codes) => this.isDown(codes));
    return index + 1;
  }

  private buttons(): number {
    let buttons = 0;
    if (this.isDown(this.bindings.forward)) buttons |= BUTTON.FORWARD;
    if (this.isDown(this.bindings.back)) buttons |= BUTTON.BACK;
    if (this.isDown(this.bindings.left)) buttons |= BUTTON.LEFT;
    if (this.isDown(this.bindings.right)) buttons |= BUTTON.RIGHT;
    if (this.isDown(this.bindings.jump)) buttons |= BUTTON.JUMP;
    if (this.isDown(this.bindings.duck)) buttons |= BUTTON.DUCK;
    if (this.isDown(this.bindings.walk)) buttons |= BUTTON.WALK;
    if (this.isDown(this.bindings.reload)) buttons |= BUTTON.RELOAD;
    // Boton izquierdo del raton: disparar. Derecho: apuntar.
    if (this.mouseButtons & 1) buttons |= BUTTON.ATTACK;
    if (this.mouseButtons & (1 << 2)) buttons |= BUTTON.AIM;
    return buttons;
  }

  /**
   * Escala la sensibilidad con el zoom. 1 es la vista normal; con la mira, la
   * proporcion entre el FOV apuntado y el de siempre.
   */
  setZoomFactor(factor: number): void {
    this.zoomFactor = clamp(factor, 0.05, 1);
  }

  /** Si el jugador tiene el marcador abierto. No viaja al servidor. */
  get showingStats(): boolean {
    return this.isDown(this.bindings.stats);
  }

  private isDown(codes: string[]): boolean {
    return codes.some((code) => this.pressed.has(code));
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    this.pressed.add(event.code);
    // El espacio hace scroll y el tabulador cambia el foco: solo se bloquean
    // con el juego activo, para no romper la navegacion por teclado del menu.
    if (this.locked && (event.code === 'Space' || event.code === 'Tab')) {
      event.preventDefault();
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private readonly handleBlur = (): void => {
    // Al perder el foco se sueltan todas las teclas: evita quedarse "andando".
    this.pressed.clear();
    this.mouseButtons = 0;
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    this.mouseButtons |= 1 << event.button;
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    this.mouseButtons &= ~(1 << event.button);
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.pendingYaw += event.movementX;
    this.pendingPitch += event.movementY;
  };

  private readonly handleLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) {
      this.pressed.clear();
      this.mouseButtons = 0;
    }
    this.onLockChange?.(this.locked);
  };

  private readonly preventDefault = (event: Event): void => {
    event.preventDefault();
  };
}
