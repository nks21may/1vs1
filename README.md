# NEONDUEL

Shooter 3D **1 contra 1** para navegador, con servidor autoritativo y movimiento
calcado del de Counter-Strike: aceleración de Quake, air-strafing, counter-strafe,
duck-jump y patrones de retroceso memorizables.

No usa un solo archivo de assets: la geometría, las texturas, los efectos y el
sonido se generan por código.

```bash
npm install
npm run dev     # servidor en :8080 y cliente en :5173
```

Abre <http://localhost:5173>. Para jugar solo, pulsa **Practicar con bot**; para
un duelo real, **Buscar rival** en dos pestañas o dos equipos.

---

## Índice

- [Cómo se juega](#cómo-se-juega)
- [Arquitectura](#arquitectura)
- [El netcode](#el-netcode)
- [El movimiento](#el-movimiento)
- [El mapa](#el-mapa)
- [Comandos](#comandos)
- [Tests](#tests)
- [Despliegue](#despliegue)

---

## Cómo se juega

| Tecla | Acción |
|---|---|
| `W` `A` `S` `D` | Moverse |
| `Espacio` | Saltar |
| `Ctrl` / `C` | Agacharse |
| `Shift` | Andar en silencio (más lento, más preciso) |
| `Q` | Cambiar entre rifle y pistola |
| `R` | Recargar |
| Clic izquierdo | Disparar |
| `Esc` | Liberar el ratón |

Reglas: partidas al mejor de 15 (primero a 8 rondas), sin reaparición dentro de la
ronda, 90 segundos por ronda y cambio de lado en cada una.

Tres cosas que conviene saber antes del primer duelo:

1. **Moverse arruina la puntería.** La dispersión crece con el cuadrado de la
   velocidad. Hay que frenar antes de disparar, y la forma rápida de frenar es
   pulsar la dirección contraria (*counter-strafe*): la fricción del suelo es
   constante por debajo de 80 u/s, así que el jugador se detiene casi en seco.
2. **La primera bala es exacta.** A partir de la segunda entra el patrón de
   retroceso, que es fijo y se puede memorizar: sube, tira a la izquierda y luego
   vuelve a la derecha. La mira solo acompaña una fracción de esa subida, así que
   compensar con el ratón es cosa tuya.
3. **En el aire no se acierta**, pero sí se gana velocidad: girando la vista hacia
   el lado que estás pulsando se supera el límite de carrera (*air-strafing*).

---

## Arquitectura

```
packages/shared/     Simulación determinista (la usan cliente y servidor)
  math.ts            Vectores, ángulos y RNG reproducible
  collision.ts       Trazado de AABB barridos (estilo Quake)
  movement.ts        Física de movimiento tipo Source
  map.ts             Geometría del mapa, generada por código
  weapons.ts         Armas, retroceso y dispersión
  hitscan.ts         Balas contra geometría y hitboxes
  player.ts          Estado del jugador y paso de simulación
  lagcomp.ts         Historial y rebobinado del mundo
  match.ts           Fases, rondas y marcador
  protocol.ts        Mensajes de red y validación de entrada

apps/server/         Servidor autoritativo (Node + ws)
  session.ts         Una partida: simula, resuelve disparos, difunde estado
  game-server.ts     Emparejamiento y bucle global
  bot.ts             Bot de práctica con tres niveles
  server.ts          HTTP + WebSocket
  connection.ts      Transporte abstracto (permite bots y tests sin sockets)

apps/client/         Cliente 3D (three.js + Vite)
  game/prediction.ts Predicción local y reconciliación
  game/interpolation.ts  Interpolación de la entidad remota
  game/input.ts      Teclado, ratón y captura del puntero
  render/            Escena, mapa, avatares, arma y efectos
  hud.ts, audio.ts   Interfaz y sonido sintetizado
```

La decisión de fondo: **la simulación vive en un paquete compartido**, y cliente y
servidor ejecutan exactamente el mismo código sobre los mismos datos. Es lo que
permite predecir el movimiento sin que se separe del estado autoritativo, y lo que
hace que un bug de física sea reproducible en un test de Node.

---

## El netcode

Tres mecanismos que resuelven tres problemas distintos:

**Predicción con reconciliación** (para tu propio jugador). El cliente aplica cada
comando al instante y lo guarda. Cuando llega la instantánea del servidor, compara
lo que había predicho para ese mismo comando; si coincide -- lo normal -- no hace
nada, y si no, adopta el estado del servidor y vuelve a aplicar los comandos aún
sin confirmar. Sin esto, moverse costaría un viaje de ida y vuelta.

**Interpolación** (para el rival). Se le dibuja 100 ms en el pasado, entre las dos
instantáneas que rodean ese instante. Se pierde algo de inmediatez visual y se gana
un movimiento continuo aunque los paquetes lleguen irregulares.

**Compensación de latencia** (para los disparos). El servidor guarda medio segundo
de historial de posiciones. Al resolver un disparo, rebobina el mundo al momento
que el tirador estaba viendo (su latencia más su interpolación) y evalúa el impacto
ahí. Sin esto habría que apuntar por delante del rival en proporción al ping.

El rebobinado está acotado a 200 ms y se recorta dos veces, así que lo máximo que
se consigue mintiendo sobre la propia latencia es disparar a un pasado de 200 ms.

**El servidor no se fía de nada.** Valida cada mensaje antes de tocar la física
(rechaza `NaN`, `dt` inflados, secuencias repetidas y bits de botón inventados),
limita cuántos comandos procesa por tick para que recuperar un retraso no se
convierta en correr más rápido, y aplica un presupuesto de mensajes por segundo.
El cliente decide *qué teclas pulsa*; nada más.

---

## El movimiento

Constantes copiadas de Source, porque son las que producen esa sensación:

| Parámetro | Valor |
|---|---|
| Tick | 64 Hz |
| Gravedad | 800 u/s² |
| Velocidad máxima | 250 u/s (×0,86 con rifle) |
| Aceleración / en el aire | 5,5 / 12 |
| Tope de `wishspeed` aéreo | 30 u/s |
| Fricción / velocidad de parada | 5,2 / 80 u/s |
| Impulso de salto | 301,993 u/s (57 unidades de altura) |
| Escalón máximo | 18 unidades |

La clave del "feel" está en dos detalles. La aceleración limita la *proyección* de
la velocidad sobre la dirección deseada, no su módulo: por eso girar mientras se
strafea en el aire añade velocidad indefinidamente. Y la fricción pasa a ser
constante por debajo de 80 u/s, que es lo que permite pararse en seco.

Hay recorte anti-bunnyhop al saltar y penalización al aterrizar fuerte, así que el
bhop encadenado da control pero no velocidad infinita.

---

## El mapa

`ATRIUM` es una arena simétrica generada por código. Solo se diseña la mitad oeste
y se refleja, lo que garantiza que los dos lados son idénticos: en un 1v1 eso no es
un detalle estético, es una condición de justicia. Un test lo comprueba brush a
brush.

Un monolito central corta la línea de tiro entre spawns, dos balcones dan juego
alto, y las escaleras tienen peldaños de 16 unidades (por debajo del escalón máximo
de 18) para poder subirlas caminando. Hay tests que recorren esas rutas de verdad
con la física real, para que no se cuele una escalera imposible o un pasillo
bloqueado.

---

## Comandos

```bash
npm run dev          # servidor + cliente con recarga en caliente
npm run build        # compila cliente y servidor a dist/
npm start            # sirve el juego compilado en :8080
npm test             # toda la batería de tests
npm run test:coverage
npm run typecheck    # comprobación de tipos de todo el monorepo
npm run check        # typecheck + tests (lo que corre en CI)
```

Variables de entorno del servidor: `PORT` (8080) y `HOST` (0.0.0.0).

---

## Tests

266 tests, ~97% de cobertura sobre la simulación y el servidor.

```
packages/shared/test/   Física, colisión, armas, hitscan, reglas, protocolo, mapa
apps/server/test/       Sesión autoritativa, emparejamiento, bot, y e2e por WebSocket
apps/client/test/       Predicción, interpolación, entrada y ajustes
```

Lo que se comprueba no son detalles de implementación sino propiedades del juego:
que el salto alcanza su altura teórica, que el counter-strafe frena en menos de
125 ms, que el air-strafing gana velocidad y quedarse quieto no, que una pared
detiene una bala, que no se atraviesa geometría ni a 6000 u/s, que reproducir los
mismos comandos da exactamente el mismo estado, y que un disparo compensado acierta
donde el cliente veía al rival y no donde está ahora.

El test de extremo a extremo levanta el servidor real en un puerto efímero y habla
con él por WebSocket como lo haría el navegador: emparejamiento, movimiento
confirmado, paquetes malformados y desconexiones.

La simulación no consulta ningún reloj -- avanza por pasos explícitos -- así que
una partida completa se ejecuta en milisegundos y sin esperas ni tests inestables.

---

## Despliegue

```bash
npm run build
PORT=8080 npm start
```

El mismo proceso sirve los archivos estáticos del cliente y el WebSocket, así que
basta con exponer un puerto. Detrás de un proxy inverso hay que permitir la
actualización a WebSocket; con TLS, el cliente usa `wss://` automáticamente.

Cada partida es una sesión independiente en memoria; el emparejamiento junta a los
jugadores de dos en dos y libera la sesión cuando se vacía. Para escalar a varias
instancias haría falta un emparejador externo, que hoy no existe.

---

## Limitaciones conocidas

- **Sin cuentas ni persistencia**: los resultados no se guardan.
- **Emparejamiento simple**: por orden de llegada, sin nivel ni regiones.
- **Un solo mapa**, aunque la definición admite añadir más sin tocar el motor.
- **El protocolo es JSON**: cómodo de depurar y suficiente para dos jugadores
  (~15 KB/s), pero un formato binario sería más eficiente con más jugadores.
- **El bot no usa navegación por mallas**: persigue en línea recta y rodea cuando
  detecta que no progresa. Le basta para esta arena, no para un mapa con pasillos.
