/**
 * Avatares de los jugadores.
 *
 * Figuras low-poly con siluetas muy marcadas: en un mapa oscuro lo que importa
 * es reconocer al rival en un cuarto de segundo, asi que el modelo es simple y
 * el contorno emisivo hace el trabajo. No se dibujan etiquetas con el nombre a
 * proposito: delatarian una posicion que el jugador no deberia conocer.
 */

import {
  BoxGeometry,
  CircleGeometry,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';

import { PLAYER_HEIGHT_DUCKED, PLAYER_HEIGHT_STANDING, clamp } from '@neonduel/shared';

import type { InterpolatedPlayer } from '../game/interpolation.js';
import { avatarPose } from './avatar-pose.js';
import { disposeObject, drawableOf } from './dispose.js';
import { PALETTE, applyViewAngles } from './scene.js';

const DUCK_SCALE = PLAYER_HEIGHT_DUCKED / PLAYER_HEIGHT_STANDING;

/** Crea una caja con su contorno emisivo, que es lo que da la silueta. */
const neonBox = (
  width: number,
  height: number,
  depth: number,
  color: Color,
  emissiveStrength = 0.35,
): Group => {
  const group = new Group();
  const geometry = new BoxGeometry(width, height, depth);

  const body = new Mesh(
    geometry,
    new MeshStandardMaterial({
      color: 0x0b0f18,
      roughness: 0.55,
      metalness: 0.35,
      emissive: color,
      emissiveIntensity: emissiveStrength,
    }),
  );
  group.add(body);

  const edges = new LineSegments(
    new EdgesGeometry(geometry),
    new LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
  );
  group.add(edges);

  return group;
};

export class PlayerAvatar {
  readonly root = new Group();
  private readonly body = new Group();
  private readonly head: Group;
  private readonly shadow: Mesh;
  private readonly color: Color;
  private deathTimer = 0;
  private readonly legs: [Group, Group];
  /** Fase del ciclo de paso, que avanza con la distancia recorrida. */
  private stridePhase = 0;

  constructor(color: number) {
    this.color = new Color(color);

    // Piernas, torso y cabeza: proporciones del hull de 72 unidades.
    // Cada pierna cuelga de un grupo colocado en la cadera: girando el grupo,
    // la pierna pivota desde arriba como es debido y no desde el suelo.
    this.legs = [0, 1].map((i) => {
      const hip = new Group();
      hip.position.set(i === 0 ? -6 : 6, 30, 0);
      const leg = neonBox(9, 30, 16, this.color, 0.18);
      leg.position.y = -15;
      hip.add(leg);
      return hip;
    }) as [Group, Group];

    const torso = neonBox(30, 26, 20, this.color, 0.3);
    torso.position.y = 43;
    this.head = neonBox(16, 16, 16, this.color, 0.5);
    this.head.position.y = 64;

    // Visor: la unica superficie realmente brillante, marca hacia donde mira.
    const visor = new Mesh(new BoxGeometry(12, 4, 1), new MeshBasicMaterial({ color: this.color }));
    visor.position.set(0, 1, -8.5);
    this.head.add(visor);

    this.body.add(...this.legs, torso, this.head);
    this.root.add(this.body);

    // Sombra de contacto: ayuda a juzgar la distancia y la altura.
    this.shadow = new Mesh(
      new CircleGeometry(20, 20),
      new MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.6;
    this.root.add(this.shadow);
  }

  update(player: InterpolatedPlayer, dt: number): void {
    this.root.position.set(player.pos.x, player.pos.z, -player.pos.y);
    this.root.visible = true;

    // El cuerpo gira con el yaw; la cabeza ademas cabecea con el pitch.
    applyViewAngles(this.body, player.yaw, 0);
    this.head.rotation.x = clamp((-player.pitch * Math.PI) / 180, -0.9, 0.9);

    const targetScale = player.ducking ? DUCK_SCALE : 1;
    this.body.scale.y += (targetScale - this.body.scale.y) * Math.min(1, dt * 14);

    if (!player.alive) {
      // Al morir la figura se tumba y se apaga en lugar de desaparecer de golpe.
      this.deathTimer = Math.min(1, this.deathTimer + dt * 2.2);
      this.body.rotation.x = -this.deathTimer * Math.PI * 0.45;
      this.body.position.y = -this.deathTimer * 18;
      this.setOpacity(1 - this.deathTimer * 0.75);
      this.shadow.visible = false;
    } else {
      this.deathTimer = 0;
      this.body.position.y = 0;
      this.setOpacity(1);
      this.shadow.visible = true;

      // La pose se aplica despues de `applyViewAngles`: con el orden YXZ, la X
      // inclina hacia delante y la Z alabea, las dos en los ejes del avatar.
      const pose = avatarPose(this.stridePhase, player.vel, player.yaw, player.onGround, dt);
      this.stridePhase = pose.phase;
      this.body.rotation.x += pose.lean;
      this.body.rotation.z += pose.roll;
      this.legs[0].rotation.x = pose.legs[0];
      this.legs[1].rotation.x = pose.legs[1];
    }
  }

  private setOpacity(opacity: number): void {
    this.body.traverse((object: Object3D) => {
      const material = drawableOf(object)?.material;
      // Los materiales compartidos por varias partes llegan en lista; el avatar
      // no usa ninguno, asi que ahi no hay nada que atenuar.
      if (!material || Array.isArray(material)) return;
      material.transparent = opacity < 1;
      material.opacity = opacity;
    });
  }

  dispose(): void {
    disposeObject(this.root);
  }
}

/** Mantiene los avatares sincronizados con los jugadores que llegan por red. */
export class AvatarManager {
  private readonly avatars = new Map<number, PlayerAvatar>();

  constructor(private readonly parent: Group) {}

  update(players: InterpolatedPlayer[], dt: number, localId: number): void {
    const seen = new Set<number>();

    for (const player of players) {
      if (player.id === localId) continue;
      seen.add(player.id);

      let avatar = this.avatars.get(player.id);
      if (!avatar) {
        // El rival siempre se dibuja en magenta y el jugador local en cian:
        // el color identifica el bando, no a la persona.
        avatar = new PlayerAvatar(PALETTE.teamB);
        this.avatars.set(player.id, avatar);
        this.parent.add(avatar.root);
      }
      avatar.update(player, dt);
    }

    for (const [id, avatar] of this.avatars) {
      if (seen.has(id)) continue;
      this.parent.remove(avatar.root);
      avatar.dispose();
      this.avatars.delete(id);
    }
  }

  clear(): void {
    for (const avatar of this.avatars.values()) {
      this.parent.remove(avatar.root);
      avatar.dispose();
    }
    this.avatars.clear();
  }
}
