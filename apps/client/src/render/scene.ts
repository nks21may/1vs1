/**
 * Escena, camara y post-proceso.
 *
 * Estetica "hormigon y neon": geometria mate y oscura, aristas emisivas y una
 * niebla densa que oculta el fondo del mapa. Todo el aspecto se genera por
 * codigo (colores, degradados y texturas de rejilla en canvas), sin un solo
 * archivo de textura: el juego entero cabe en el bundle y carga al instante.
 *
 * Conversion de ejes: la simulacion usa Z-up (como Source) y three.js Y-up.
 * `toThree` es el unico punto donde se traduce, para que el resto del render no
 * tenga que pensar en ello.
 */

import {
  AmbientLight,
  BackSide,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PointLight,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { Vec3 } from '@neonduel/shared';

/** Paleta del juego. Los dos equipos se distinguen solo por el color. */
export const PALETTE = {
  background: 0x04060c,
  fog: 0x070c18,
  floor: 0x1c2432,
  wall: 0x10141d,
  platform: 0x1b2231,
  cover: 0x222b3d,
  accent: 0x090c14,
  stair: 0x1a2130,
  edgeCool: 0x35b6e8,
  edgeWarm: 0xe3559d,
  teamA: 0x2ce8ff,
  teamB: 0xff3ea5,
  impact: 0xffd166,
  /** Impacto sobre un jugador: se distingue del impacto en pared. */
  bloodImpact: 0xff5fae,
  tracer: 0x9ff7ff,
} as const;

/** Convierte una posicion de la simulacion (Z-up) a coordenadas de three (Y-up). */
export const toThree = (v: Vec3, out = new Vector3()): Vector3 => out.set(v.x, v.z, -v.y);

/** Convierte los angulos de vista de la simulacion a rotacion de camara. */
export const applyViewAngles = (
  object: { rotation: { order: string; x: number; y: number; z: number } },
  yawDeg: number,
  pitchDeg: number,
): void => {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  object.rotation.order = 'YXZ';
  // yaw 0 mira hacia +X, que en three es -90 grados respecto a -Z.
  object.rotation.y = yaw - Math.PI / 2;
  object.rotation.x = -pitch;
  object.rotation.z = 0;
};

/** Textura de rejilla generada en canvas: da escala al suelo sin ficheros. */
export const createGridTexture = (
  size = 256,
  cells = 4,
  lineColor = '#1b2740',
  fillColor = '#0b0f18',
): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = fillColor;
  ctx.fillRect(0, 0, size, size);

  const step = size / cells;
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * step) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
};

/** Cupula de cielo con degradado vertical. */
const createSky = (): Mesh => {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#0a1430');
  gradient.addColorStop(0.45, '#070c18');
  gradient.addColorStop(0.7, '#0d0a18');
  gradient.addColorStop(1, '#030408');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 256);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const sky = new Mesh(
    new SphereGeometry(6000, 24, 16),
    new MeshBasicMaterial({ map: texture, side: BackSide, fog: false, depthWrite: false }),
  );
  sky.renderOrder = -1;
  return sky;
};

export interface RenderContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  setSize(width: number, height: number): void;
  setBloomEnabled(enabled: boolean): void;
  setFov(fov: number): void;
  render(): void;
}

export const createRenderContext = (canvas: HTMLCanvasElement): RenderContext => {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  // Por encima de 2x el coste crece mucho y la ganancia visual es marginal.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(PALETTE.background);
  scene.fog = new Fog(PALETTE.fog, 900, 4200);
  scene.add(createSky());

  const camera = new PerspectiveCamera(74, 16 / 9, 1, 9000);

  // Iluminacion: poca luz difusa y dos focos de color que tinen cada mitad del
  // mapa, para que el jugador sepa siempre en que lado esta.
  scene.add(new AmbientLight(0x35496a, 2.1));
  scene.add(new HemisphereLight(0x4a6f9c, 0x0d1018, 1.0));

  const key = new DirectionalLight(0xbcd4ff, 1.8);
  key.position.set(600, 1400, 400);
  scene.add(key);

  const coolLight = new PointLight(PALETTE.teamA, 3.2, 2600, 1.6);
  coolLight.position.set(-1000, 300, 0);
  scene.add(coolLight);

  const warmLight = new PointLight(PALETTE.teamB, 3.2, 2600, 1.6);
  warmLight.position.set(1000, 300, 0);
  scene.add(warmLight);

  // El `antialias: true` del renderer solo cubre el dibujo directo al canvas.
  // Con post-proceso la imagen la produce el composer sobre su propio render
  // target, que por defecto no tiene multisampling: de ahi los dientes de
  // sierra con el bloom encendido. Se le pasa un target con MSAA, que es lo que
  // mejor trata las aristas duras y las lineas de neon del mapa.
  const size = renderer.getSize(new Vector2());
  const composerTarget = new WebGLRenderTarget(size.width, size.height, {
    // Mismo formato que usaria el composer por su cuenta: el bloom necesita
    // rango alto para no cortar los brillos.
    type: HalfFloatType,
    samples: Math.min(4, renderer.capabilities.maxSamples),
  });
  const composer = new EffectComposer(renderer, composerTarget);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // Intensidad moderada y umbral alto: el brillo debe destacar las aristas y los
  // disparos, no lavar toda la imagen.
  const bloomPass = new UnrealBloomPass(new Vector2(1, 1), 0.38, 0.7, 0.55);
  composer.addPass(bloomPass);

  let bloomEnabled = true;

  const setSize = (width: number, height: number): void => {
    renderer.setSize(width, height, false);
    // Redimensiona los dos render targets internos (conservando el MSAA) y de
    // paso los passes, ya con el ratio de pixeles aplicado: sin esto el
    // antialiasing se perderia al cambiar el tamano de la ventana.
    composer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  };

  return {
    renderer,
    scene,
    camera,
    setSize,
    setBloomEnabled(enabled: boolean) {
      bloomEnabled = enabled;
      bloomPass.enabled = enabled;
    },
    setFov(fov: number) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    },
    render() {
      if (bloomEnabled) composer.render();
      else renderer.render(scene, camera);
    },
  };
};
