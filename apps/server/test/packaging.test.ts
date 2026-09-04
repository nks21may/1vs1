/**
 * Coherencia entre el Dockerfile y lo que el servidor espera encontrar.
 *
 * La imagen no lleva el repositorio, solo tres cosas: el bundle del servidor,
 * el cliente compilado y `ws`. El servidor localiza el cliente por una ruta
 * relativa a su propio archivo, asi que si el Dockerfile coloca cualquiera de
 * las dos carpetas en otro sitio el juego arranca igual, dice que escucha, y
 * responde 404 a todo. Es un fallo que no aparece en ningun log y que solo se
 * ve abriendo el navegador contra produccion.
 *
 * Estos tests no fijan las rutas por su cuenta: las leen de `server.ts`, del
 * script de build y del Dockerfile, y comprueban que las tres versiones de la
 * verdad coinciden.
 */

import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

const dockerfile = read('Dockerfile');
const serverSource = read('apps/server/src/server.ts');
const buildScript = (
  JSON.parse(read('apps/server/package.json')) as { scripts: Record<string, string> }
).scripts.build;

/** Directorio de trabajo de la imagen: los destinos de COPY cuelgan de el. */
const workdir = /^WORKDIR (\S+)$/m.exec(dockerfile.split('AS runtime')[1] ?? '')?.[1] ?? '/app';

/** Destinos de los `COPY --from=...`, ya resueltos contra el WORKDIR. */
const copies = [...dockerfile.matchAll(/^COPY --from=\S+ (\S+) (\S+)$/gm)].map(
  ([, source, target]) => ({
    source,
    target: posix.resolve(workdir, target),
  }),
);

const copyOf = (fragment: string): string | undefined =>
  copies.find((copy) => copy.source.includes(fragment))?.target;

/** El unico argumento del CMD que apunta a un archivo del proyecto. */
const entrypoint = posix.resolve(
  workdir,
  (JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)?.[1] ?? '[]') as string[])[1] ?? '',
);

describe('empaquetado en Docker', () => {
  it('arranca el mismo archivo que genera el script de build', () => {
    const outfile = /--outfile=(\S+)/.exec(buildScript)?.[1];
    expect(outfile).toBeDefined();

    // `dist/server.js` del script -> `apps/server/dist` copiado en la imagen.
    expect(entrypoint).toBe(posix.join(copyOf('apps/server/dist') ?? '', 'server.js'));
    expect(outfile?.endsWith('server.js')).toBe(true);
  });

  it('deja el cliente donde el servidor lo busca', () => {
    // La ruta relativa esta escrita una sola vez, en la constante CLIENT_DIST.
    const relative = /'(\.\.\/[^']*client\/dist)'/.exec(serverSource)?.[1];
    expect(relative).toBeDefined();

    const resolved = posix.resolve(posix.dirname(entrypoint), relative ?? '');
    expect(resolved).toBe(copyOf('apps/client/dist'));
  });

  it('incluye todas las dependencias que esbuild deja fuera del bundle', () => {
    const externals = [...buildScript.matchAll(/--external:(\S+)/g)].map(([, name]) => name);
    expect(externals.length).toBeGreaterThan(0);

    for (const name of externals) {
      expect(copyOf(`node_modules/${name}`)).toBe(posix.join(workdir, 'node_modules', name));
    }
  });
});
