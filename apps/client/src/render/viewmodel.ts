/**
 * Arma en primera persona.
 *
 * El modelo va colgado de la camara y se dibuja siempre por encima de la escena
 * (sin test de profundidad): es la solucion clasica para que el arma no se
 * incruste en las paredes al pegarse a ellas.
 *
 * El movimiento del arma es informacion, no adorno: el balanceo indica que te
 * estas moviendo -- y por tanto que tu punteria es mala -- y el retroceso
 * visual acompana al patron que hay que compensar.
 */

import {
  BoxGeometry,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from 'three';

import { type WeaponId, clamp, getWeapon, lerp } from '@neonduel/shared';

import { disposeObject } from './dispose.js';

const part = (
  width: number,
  height: number,
  depth: number,
  color: number,
  edgeColor: number,
): Group => {
  const group = new Group();
  const geometry = new BoxGeometry(width, height, depth);

  // El arma conserva su propio test de profundidad (asi se ve solida y no
  // translucida); lo que evita que se incruste en las paredes es limpiar el
  // buffer de profundidad justo antes de dibujarla, en `depthCleaner`.
  //
  // Los materiales se marcan como transparentes con opacidad 1: no es por el
  // aspecto, es para que three los encole en la pasada transparente, la ultima
  // en dibujarse. Si fueran opacos, la limpieza de profundidad ocurriria antes
  // de las lineas de neon del mapa y estas se verian a traves de las paredes.
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ color, transparent: true, opacity: 1 }));
  mesh.renderOrder = RENDER_ORDER_WEAPON;
  group.add(mesh);

  const edges = new LineSegments(
    new EdgesGeometry(geometry),
    new LineBasicMaterial({ color: new Color(edgeColor), transparent: true, opacity: 1 }),
  );
  edges.renderOrder = RENDER_ORDER_WEAPON + 1;
  group.add(edges);

  return group;
};

/**
 * Objeto invisible que limpia el buffer de profundidad justo antes del arma.
 *
 * Es la forma habitual de dibujar un modelo en primera persona con three: la
 * escena ya esta pintada, se borra la profundidad y el arma se dibuja encima
 * conservando su propio relieve. Sin esto habria que desactivar el test de
 * profundidad y el arma se veria hueca.
 */
const depthCleaner = (): Mesh => {
  const cleaner = new Mesh(
    new BoxGeometry(0.001, 0.001, 0.001),
    new MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      // Transparente para compartir pasada con el arma (ver `part`).
      transparent: true,
      opacity: 0,
    }),
  );
  cleaner.renderOrder = RENDER_ORDER_WEAPON - 1;
  cleaner.frustumCulled = false;
  cleaner.onBeforeRender = (renderer) => renderer.clearDepth();
  return cleaner;
};

/**
 * Construye una silueta de arma con cajas.
 *
 * Las medidas estan pensadas para verse a unas 34 unidades de la camara: la
 * pieza mas cercana (la culata) debe quedar bastante por delante del plano de
 * recorte, o sus aristas cruzan la pantalla en diagonal.
 */
const buildWeapon = (weapon: WeaponId): Group => {
  const group = new Group();
  const bodyColor = 0x0c1018;
  // El borde es el color del trazador del arma: asi la silueta que se ve en la
  // mano y la linea que deja la bala son lo mismo, sin listas paralelas.
  const edge = getWeapon(weapon).tracerColor;

  if (weapon === 'sniper') {
    const receiver = part(2.8, 3, 15, bodyColor, edge);
    receiver.position.set(0, 0, -1);
    // Canon largo: es lo que separa su silueta de la del rifle de un vistazo.
    const barrel = part(1.1, 1.1, 22, bodyColor, edge);
    barrel.position.set(0, 0.4, -18);
    const scope = part(1.8, 1.8, 8, bodyColor, edge);
    scope.position.set(0, 3, -5);
    const scopeMount = part(0.8, 1.6, 1.2, bodyColor, edge);
    scopeMount.position.set(0, 1.8, -5);
    const bolt = part(2.6, 0.9, 1.2, bodyColor, edge);
    bolt.position.set(1.6, 1, 2);
    const stock = part(2.4, 3.2, 9, bodyColor, edge);
    stock.position.set(0, -0.6, 9);
    group.add(receiver, barrel, scope, scopeMount, bolt, stock);
  } else if (weapon === 'knife') {
    // Silueta larga y plana: lo que tiene que leerse de un vistazo es que en la
    // mano no hay canon, porque de eso depende saber que no se puede responder.
    // Hoja ancha y alta, mango corto: en aristas de neon una hoja fina se ve
    // de canto y desaparece, y lo unico que hay que leer aqui es que no hay canon.
    const blade = part(0.9, 3.4, 17, bodyColor, edge);
    blade.position.set(0, 1.8, -10);
    blade.rotation.x = -0.1;
    const guard = part(3.2, 1, 1.2, bodyColor, edge);
    guard.position.set(0, 0.3, -0.8);
    const grip = part(1.6, 2, 6, bodyColor, edge);
    grip.position.set(0, -0.9, 2.6);
    grip.rotation.x = 0.16;
    group.add(blade, guard, grip);
  } else if (weapon === 'rifle') {
    const receiver = part(3, 3.2, 13, bodyColor, edge);
    receiver.position.set(0, 0, -2);
    const barrel = part(1.3, 1.3, 12, bodyColor, edge);
    barrel.position.set(0, 0.5, -13);
    const magazine = part(2, 5.4, 3.4, bodyColor, edge);
    magazine.position.set(0, -3.3, -1);
    magazine.rotation.x = 0.25;
    const stock = part(2.4, 2.8, 7, bodyColor, edge);
    stock.position.set(0, -0.4, 7.5);
    const sight = part(0.7, 1.4, 1, bodyColor, edge);
    sight.position.set(0, 2.2, -7);
    group.add(receiver, barrel, magazine, stock, sight);
  } else {
    const slide = part(2.4, 2.6, 9, bodyColor, edge);
    slide.position.set(0, 0, -3);
    const grip = part(2, 5.4, 3, bodyColor, edge);
    grip.position.set(0, -3.6, 1.5);
    grip.rotation.x = 0.3;
    group.add(slide, grip);
  }

  return group;
};

/** Convergencia del arma hacia el centro de la pantalla, en radianes. */
const YAW_CONVERGENCE = 0.12;

/** El arma se dibuja despues de toda la escena. */
const RENDER_ORDER_WEAPON = 1000;

export class ViewModel {
  readonly root = new Group();
  private weaponGroup: Group;
  private currentWeapon: WeaponId = 'rifle';

  private bobPhase = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private kick = 0;
  private reloadProgress = 0;

  /**
   * Posicion de reposo: a la derecha y abajo del centro. La distancia (34
   * unidades) es la que deja el arma con un tamano razonable a 74 grados de
   * campo de vision sin que la culata invada el centro de la pantalla.
   */
  private readonly restPosition = { x: 10.5, y: -9, z: -33 };

  constructor() {
    this.root.add(depthCleaner());
    this.weaponGroup = buildWeapon('rifle');
    this.root.add(this.weaponGroup);
    this.root.position.set(this.restPosition.x, this.restPosition.y, this.restPosition.z);
    // Ligera convergencia hacia el centro: evita que el arma parezca pegada al
    // borde y ayuda a leer hacia donde apunta.
    this.root.rotation.y = YAW_CONVERGENCE;
  }

  setWeapon(weapon: WeaponId): void {
    if (weapon === this.currentWeapon) return;
    this.currentWeapon = weapon;
    this.root.remove(this.weaponGroup);
    disposeObject(this.weaponGroup);
    this.weaponGroup = buildWeapon(weapon);
    this.root.add(this.weaponGroup);
    // Un pequeno tiron al sacar el arma nueva.
    this.kick = 1.4;
  }

  /** Retroceso visual al disparar. */
  punch(strength = 1): void {
    this.kick = Math.min(3, this.kick + strength);
  }

  update(options: {
    dt: number;
    speed: number;
    maxSpeed: number;
    onGround: boolean;
    yawDelta: number;
    pitchDelta: number;
    reloading: number;
    alive: boolean;
  }): void {
    const { dt, speed, maxSpeed, onGround, yawDelta, pitchDelta, reloading, alive } = options;

    this.root.visible = alive;
    if (!alive) return;

    // Balanceo: la frecuencia sigue a la velocidad real del jugador.
    const speedRatio = maxSpeed > 0 ? clamp(speed / maxSpeed, 0, 1) : 0;
    this.bobPhase += dt * (6 + speedRatio * 9) * (onGround ? 1 : 0.25);
    const bobAmount = speedRatio * (onGround ? 1 : 0.3);
    const bobX = Math.cos(this.bobPhase) * 0.9 * bobAmount;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.8 * bobAmount;

    // Inercia: el arma se retrasa respecto al giro de la vista.
    this.swayYaw = lerp(this.swayYaw, clamp(-yawDelta * 0.06, -3, 3), 1 - Math.exp(-dt * 12));
    this.swayPitch = lerp(this.swayPitch, clamp(pitchDelta * 0.06, -2, 2), 1 - Math.exp(-dt * 12));

    this.kick = Math.max(0, this.kick - dt * 9);
    this.reloadProgress = reloading;

    const reloadDip = Math.sin(this.reloadProgress * Math.PI) * 5;

    this.root.position.set(
      this.restPosition.x + bobX + this.swayYaw,
      this.restPosition.y + bobY + this.swayPitch - reloadDip,
      this.restPosition.z + this.kick * 1.1,
    );
    this.root.rotation.set(
      this.kick * 0.06 - this.reloadProgress * 0.5,
      // `YAW_CONVERGENCE` se suma aqui y no solo en el constructor porque este
      // `set` sobreescribe la rotacion entera en cada fotograma.
      YAW_CONVERGENCE + this.swayYaw * 0.03,
      this.swayPitch * 0.02 + Math.sin(this.reloadProgress * Math.PI) * 0.4,
    );
  }
}
