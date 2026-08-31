import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const sharedSrc = fileURLToPath(new URL('./packages/shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@neonduel/shared': sharedSrc,
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/shared/src/**/*.ts',
        'apps/server/src/**/*.ts',
        // Del cliente solo la logica pura: el render y el audio necesitan WebGL
        // y Web Audio, y se verifican ejecutando el juego, no con unidades.
        'apps/client/src/game/**/*.ts',
      ],
      exclude: ['**/index.ts', 'apps/client/src/game/game.ts', 'apps/client/src/game/net.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
