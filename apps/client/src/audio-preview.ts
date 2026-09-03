// Banco de pruebas del audio (T18). No se publica: sirve para renderizar los
// sonidos sin tarjeta de sonido y poder medirlos y escucharlos fuera del juego.
import { AudioEngine, type SoundName } from './audio.js';

/**
 * Renderiza un solo disparo en un contexto offline y devuelve el PCM en base64.
 * Cada llamada vuelve a sortear la variacion aleatoria del disparo, asi que
 * pedir varios seguidos sirve para comprobar que una rafaga no se repite.
 */
const renderSound = async (name: SoundName, seconds: number): Promise<string> => {
  const rate = 48000;
  const offline = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);

  // El motor crea su contexto desde `window.AudioContext`; se le pasa el offline
  // para renderizar sin altavoces y sin necesitar un gesto del usuario.
  const real = window.AudioContext;
  (window as unknown as { AudioContext: unknown }).AudioContext = function () {
    return offline;
  };
  const engine = new AudioEngine();
  engine.init();
  (window as unknown as { AudioContext: unknown }).AudioContext = real;

  // Volumen al maximo: es el peor caso para saturar, que es lo que hay que medir.
  engine.setVolume(1);
  engine.play(name, 0);

  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
};

(window as unknown as { __renderSound: typeof renderSound }).__renderSound = renderSound;
(window as unknown as { __audioReady: boolean }).__audioReady = true;
