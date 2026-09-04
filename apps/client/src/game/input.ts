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
  switchWeapon: string[];
  /** Abrir el marcador. Es solo del cliente: no viaja al servidor. */
  stats: string[];
}

export const DEFAULT_BINDINGS: InputBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  duck: ['ControlLeft', 'KeyC'],
  walk: ['ShiftLeft'],
  reload: ['KeyR'],
  switchWeapon: ['KeyQ', 'Digit2'],
  stats: ['Tab'],
};

/** Conversion de sensibilidad al estilo de Source: grados por unidad de raton. */
const YAW_PER_COUNT = 0.022;

export interface InputState {
  buttons: number;
  yaw: number;
  pitch: number;
}

export class InputManager {
  private readonly pressed = new Set<string>();
  private mouseButtons = 0;
  private pendingYaw = 0;
  private pendingPitch = 0;

  yaw = 0;
  pitch = 0;
  sensitivity = 2;
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
    this.yaw = normalizeAngle(this.yaw - this.pendingYaw * YAW_PER_COUNT * this.sensitivity);
    const pitchDelta = this.pendingPitch * YAW_PER_COUNT * this.sensitivity;
    this.pitch = clamp(
      this.pitch + (this.invertY ? -pitchDelta : pitchDelta),
      -MAX_PITCH,
      MAX_PITCH,
    );
    this.pendingYaw = 0;
    this.pendingPitch = 0;

    return { buttons: this.buttons(), yaw: this.yaw, pitch: this.pitch };
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
    if (this.isDown(this.bindings.switchWeapon)) buttons |= BUTTON.SWITCH;
    // Boton izquierdo del raton: disparar.
    if (this.mouseButtons & 1) buttons |= BUTTON.ATTACK;
    return buttons;
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
