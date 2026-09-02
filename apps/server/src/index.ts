/**
 * Punto de entrada del proceso: arranca el servidor y gestiona el apagado
 * ordenado. Toda la construccion vive en `server.ts` para que los tests puedan
 * levantar una instancia sin ejecutar este archivo.
 */

import { TICK_INTERVAL } from './game-server.js';
import { startServer } from './server.js';

const handle = await startServer();

console.log(`[neonduel] servidor escuchando en el puerto ${handle.port}`);
console.log(`[neonduel] tick ${Math.round(1000 / TICK_INTERVAL)} Hz`);

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[neonduel] apagando...');

  // Si algun socket se resiste, no se bloquea el apagado indefinidamente.
  const forceExit = setTimeout(() => process.exit(0), 2000);
  forceExit.unref();

  void handle.stop().then(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
