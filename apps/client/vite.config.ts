import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * El paquete compartido se resuelve por alias directamente al codigo fuente:
 * asi el cliente y el servidor comparten exactamente los mismos archivos y no
 * hay riesgo de usar una version compilada desactualizada de la simulacion.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@neonduel/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
