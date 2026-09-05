/**
 * Liberar memoria de GPU.
 *
 * three no lo hace solo: quitar una malla de la escena no suelta ni su
 * geometria ni sus materiales, y aqui se crean y destruyen avatares, armas y
 * mapas enteros varias veces por partida.
 */

import { LineSegments, Mesh, type Object3D } from 'three';

/**
 * Lo que tiene geometria y material propios, que es lo que hay que liberar.
 *
 * `object instanceof Mesh` estrecha a `Mesh<any, any>`, porque TypeScript no
 * puede deducir los parametros de tipo de la clase y los rellena con `any`;
 * con ellos se pierden los tipos de `geometry` y de `material`. Nombrar aqui
 * la forma concreta es lo que los devuelve.
 */
export const drawableOf = (object: Object3D): Mesh | LineSegments | null =>
  object instanceof Mesh || object instanceof LineSegments ? object : null;

/** Suelta la geometria y los materiales de un objeto y de toda su descendencia. */
export const disposeObject = (root: Object3D): void => {
  root.traverse((object: Object3D) => {
    const drawable = drawableOf(object);
    if (!drawable) return;

    drawable.geometry.dispose();
    const material = drawable.material;
    if (Array.isArray(material)) for (const one of material) one.dispose();
    else material.dispose();
  });
};
