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
- [Los mapas](#los-mapas)
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
| `1` `2` `3` `4` | Rifle, pistola, cuchillo, rifle de precisión |
| `R` | Recargar |
| Clic izquierdo | Disparar |
| Clic derecho | Apuntar (solo el arma con mira) |
| `Esc` | Liberar el ratón |

Cada arma tiene su propia tecla y siempre la misma: pulsar un número lleva a *esa*
arma, no a la siguiente de una lista.

| Ranura | Arma | Qué aporta | Qué cuesta |
|---|---|---|---|
| `1` | VEKTOR-9 (rifle) | Automática, patrón memorizable | ×0,86 de velocidad |
| `2` | AXIOM (pistola) | Velocidad de carrera intacta | 26 de daño por bala |
| `3` | SPLICE (cuchillo) | ×1,16 de velocidad: el arma de moverse | Alcance de 76 unidades |
| `4` | LONGWAVE (sniper) | Mata de un tiro al cuerpo, con mira | ×0,72 y un segundo entre tiros |

Reglas: partidas al mejor de 15 (primero a 8 rondas), sin reaparición dentro de la
ronda, 90 segundos por ronda y cambio de lado en cada una.

Cuatro cosas que conviene saber antes del primer duelo:

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
4. **El bunnyhop se encadena de oído.** Un clic agudo suena 130 ms antes de tocar
   suelo: saltar al oírlo conserva la velocidad ganada en el aire y la cadena
   sigue. Llegar tarde deja que la fricción se la coma. Un tono ascendente
   confirma cada salto que ha entrado a tiempo. Se puede apagar en los ajustes.

---

## Arquitectura

```
packages/shared/     Simulación determinista (la usan cliente y servidor)
  math.ts            Vectores, ángulos y RNG reproducible
  collision.ts       Trazado de AABB barridos (estilo Quake)
  movement.ts        Física de movimiento tipo Source
  map.ts             Geometría de los mapas, generada por código
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

**El ángulo de vista lo fija el servidor al reaparecer.** Los ángulos viajan en
cada comando del cliente, así que girar al jugador en el servidor no basta: el
siguiente comando, que aún lleva el ángulo anterior, lo desharía en el mismo
tick. Por eso el snapshot de la reaparición incluye un `viewYaw` que el cliente
aplica a su entrada. Sin él, al cambiar de lado entre rondas ambos jugadores
aparecían mirando fuera del mapa.

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
| Ventana de bunnyhop | 150 ms desde el aterrizaje |
| Techo encadenando | ×1,7 de la carrera del arma equipada |

La clave del "feel" está en dos detalles. La aceleración limita la *proyección* de
la velocidad sobre la dirección deseada, no su módulo: por eso girar mientras se
strafea en el aire añade velocidad indefinidamente. Y la fricción pasa a ser
constante por debajo de 80 u/s, que es lo que permite pararse en seco.

El bunnyhop se apoya en las dos: se gana velocidad en el aire con el strafe y se
conserva si el siguiente salto sale dentro de los 150 ms posteriores al contacto,
porque dentro de esa ventana el suelo todavía no aplica fricción. Fuera de ella la
velocidad se recorta a ×1,1 de la carrera y la cadena se rompe. El techo es
relativo al arma equipada (×1,7 de *su* carrera), de modo que encadenar saltos no
borra el peso de llevar la sniper encima. Sigue haciendo falta soltar el espacio
entre salto y salto: no hay auto-bhop.

Aterrizar tras una caída larga (más de 580 u/s) sigue costando un 15 % de la
velocidad horizontal.

---

## Los mapas

Hay dos, y se eligen en el menú antes de empezar. Los dos se generan por código:
solo se diseña la mitad oeste y se refleja, lo que garantiza que los dos lados son
idénticos. En un 1v1 eso no es un detalle estético, es una condición de justicia,
y un test lo comprueba brush a brush **en todos los mapas**.

**ATRIUM** es una arena abierta con juego vertical. Un monolito central corta la
línea de tiro entre spawns, dos balcones dan altura, y las escaleras tienen
peldaños de 16 unidades (por debajo del escalón máximo de 18) para poder subirlas
caminando.

**CONDUIT** es lo contrario: tres carriles paralelos separados por muros macizos,
sin apenas ángulos largos ni altura. Se avanza por pasillos y se pelea en las
esquinas y en los huecos que comunican los carriles. Cambiar de carril a mitad de
ronda cuesta cruzar por un hueco que el rival puede estar mirando.

Los invariantes (simetría, spawns fuera de la geometría, suelo firme al aparecer,
sin línea de tiro entre spawns, muros que encierran la arena) se comprueban sobre
todos los mapas a la vez, así que un mapa nuevo que los incumpla rompe la batería
el día que se añade. Además, en CONDUIT una búsqueda en anchura sobre posiciones
donde el jugador cabe comprueba que de verdad se puede ir andando de un spawn al
otro: un camino escrito a mano solo probaría ese camino.

El mapa lo decide el servidor y lo anuncia en el `welcome`; el cliente construye
con él tanto la malla como la geometría contra la que predice, para que no pueda
darse el caso de ver un mapa y chocar con otro.

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

335 tests, ~97% de cobertura sobre la simulación y el servidor.

```
packages/shared/test/   Física, colisión, armas, hitscan, reglas, protocolo, mapa
apps/server/test/       Sesión autoritativa, emparejamiento, bot, e2e por WebSocket y empaquetado
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

El de empaquetado no ejecuta Docker: lee el `Dockerfile` y comprueba que las rutas
a las que copia el servidor y el cliente son las mismas que el servidor busca al
arrancar. Si dejan de coincidir, la imagen se construye sin quejarse y responde
404 a todo.

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

Con Docker no hace falta ni tener Node instalado:

```bash
docker compose up -d --build   # el juego en 127.0.0.1:8090
```

El contenedor escucha solo en el loopback, para dejarlo detrás de lo que ya haya
en la máquina --un túnel de Cloudflare, un nginx--; con `PUBLISH=0.0.0.0:80` se
expone directamente. La imagen se construye en dos etapas y la final se queda con
el bundle del servidor, el cliente compilado y `ws`, así que vale igual en x86_64
que en ARM64. Los pasos completos para la VPS gratuita de Oracle Cloud están en
[DEPLOY.md](DEPLOY.md).

Cada partida es una sesión independiente en memoria; el emparejamiento junta a los
jugadores de dos en dos y libera la sesión cuando se vacía. Para escalar a varias
instancias haría falta un emparejador externo, que hoy no existe.

---

## Limitaciones conocidas

- **Sin cuentas ni persistencia**: los resultados no se guardan.
- **Emparejamiento simple**: por orden de llegada, sin nivel ni regiones.
- **Dos mapas**; la definición admite añadir más sin tocar el motor.
- **El protocolo es JSON**: cómodo de depurar y suficiente para dos jugadores
  (~15 KB/s), pero un formato binario sería más eficiente con más jugadores.
- **El bot no usa navegación por mallas**: persigue en línea recta y rodea cuando
  detecta que no progresa. Le basta para ATRIUM; en CONDUIT, que es todo pasillos,
  se le nota (ver T09 en `TODO.md`).
