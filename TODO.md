# Backlog de NEONDUEL

Lista de mejoras pensada para trabajarse **de una en una**, en sesiones cortas e
independientes. Cada tarea es autocontenida: dice qué hacer, por qué merece la
pena, dónde tocar y cuándo se considera terminada.

---

## Cómo iterar sobre este archivo

Una iteración = **una tarea completa**, no media. El ciclo es siempre el mismo:

1. Coger la primera tarea sin marcar de la prioridad más alta que quede.
2. Implementarla entera, con sus tests.
3. `npm run check` (typecheck + toda la batería) en verde.
4. Si toca al cliente, comprobarlo en el navegador de verdad, no solo por tests.
5. Marcar la casilla y anotar en una línea qué se hizo, si se desvió del plan.

Los identificadores (`T01`, `T02`...) son etiquetas estables para poder
referenciarlas, no un orden de ejecución: el orden es el de la lista.

Para automatizarlo:

```
/loop Coge la primera tarea sin marcar de TODO.md, impleméntala entera con sus
tests, deja `npm run check` en verde y marca la casilla. Una sola tarea por
iteración; si te bloqueas, anótalo en la tarea y para.
```

**Una tarea solo se marca si está verificada.** Marcar algo a medias hace que la
siguiente iteración construya sobre arena, que es el único modo de que un backlog
así se pudra.

### Qué cuenta como "hecho"

- Tests que comprueben el comportamiento observable, no la implementación (el
  criterio del resto del proyecto: "el counter-strafe frena en 125 ms", no "esta
  función devuelve 0.42").
- Cobertura sin bajar del 90% en `packages/shared` y `apps/server`.
- Sin código muerto: nada de tipos o funciones "para más adelante".
- Comentarios solo donde expliquen un *porqué* que no se lea en el código.
- README actualizado si cambia algo que un jugador o quien despliegue deba saber.

---

## P1 — Lo que más se nota jugando

- [x] **T17. Quitar los dientes de sierra (antialiasing real)**
  El renderer se crea con `antialias: true`, pero **no sirve de nada mientras el
  bloom esté encendido**: con post-proceso, la imagen final la produce el
  `EffectComposer` sobre su propio render target, y el multisampling del canvas se
  queda sin usar. Por eso se ven escalonadas las aristas, que además es justo lo
  que más abunda en este mapa (geometría de cajas y líneas de neón).
  - Dónde: [scene.ts](apps/client/src/render/scene.ts), donde hoy se hace
    `new EffectComposer(renderer)` sin más.
  - Camino recomendado: pasarle un `WebGLRenderTarget` propio con `samples: 4`
    (MSAA de WebGL2, que es lo que mejor trata las aristas duras y las líneas).
    Si hiciera falta compatibilidad sin WebGL2, la alternativa es un `SMAAPass`
    al final de la cadena; FXAA es la última opción, porque emborrona las líneas
    finas que sostienen toda la estética.
  - Hay que redimensionar el render target en `setSize`, o el efecto se pierde al
    cambiar el tamaño de la ventana.
  - Medir el coste en una GPU real: SwiftShader (el render por software que se usa
    para las capturas automáticas) no sirve para juzgar rendimiento. Si el coste
    es apreciable, exponerlo como ajuste junto a "Brillo (bloom)".
  - Hecho cuando: comparación de capturas antes/después de una arista diagonal del
    mapa que muestre el escalonado corregido, con el bloom activado.
  - **Hecho (2026-09-03).** El `EffectComposer` ya recibía un `WebGLRenderTarget`
    propio con `samples: min(4, maxSamples)`; lo que faltaba era comprobarlo, que es
    para lo que está el banco de pruebas (`aa-preview.html`). Verificado en Chrome
    sobre el mismo frame con el bloom encendido: sin multisampling las diagonales de
    neón del suelo se rompen en trazos sueltos y solo 24 píxeles de 25.275 aristas
    fuertes quedan en un valor intermedio (0,09%); con MSAA 4× son 4.532 (11,08%) y
    las diagonales salen continuas. Un ciclo `setSize(960,540)` → `setSize(1280,720)`
    devuelve exactamente las mismas cifras, así que el redimensionado no se lo come.
  - **Queda medir el coste en una GPU real.** La comprobación corre sobre SwiftShader
    (render por software), que no sirve para juzgar rendimiento, así que si el MSAA
    debe exponerse como ajuste junto a «Brillo (bloom)» sigue sin poder decidirse.

- [ ] **T18. Disparos más graves y con más cuerpo**
  Suenan finos y secos. El rifle usa un cuerpo de 150 Hz con un chasquido de
  2400 Hz y 0,24 s de cola ([audio.ts](apps/client/src/audio.ts), método
  `gunshot`); falta el golpe de pecho que hace que un arma se sienta potente.
  - Por dónde empezar: bajar el cuerpo a la zona de 70-90 Hz con caída rápida,
    añadir una capa sub-grave breve, bajar el chasquido a 1200-1600 Hz para que
    acompañe en vez de dominar, alargar algo la cola y pasar el conjunto por un
    paso bajo con la frecuencia cayendo, que es lo que da la sensación de aire
    desplazado.
  - Cuidado con pasarse de graves: en portátiles y auriculares pequeños el sub se
    pierde entero y el disparo se queda en nada. Hay que conservar suficiente
    energía en medios para que siga leyéndose sin altavoces buenos.
  - Mantener la variación aleatoria por disparo que ya existe (`detune`): sin ella
    una ráfaga suena a copia y pega.
  - La pistola debe seguir distinguiéndose del rifle de oído: más seca y con menos
    cuerpo, no simplemente el mismo sonido más agudo.
  - Hecho cuando: se ha escuchado una ráfaga completa y un disparo suelto en
    altavoces y en auriculares, y la pistola y el rifle siguen siendo
    distinguibles sin mirar el HUD.
  - **Implementado y medido (2026-09-03), pendiente del oído.** El disparo pasa a
    cuatro capas por un paso bajo que cae (sub, cuerpo de sierra, chasquido y
    cola), con el suelo del barrido atado al brillo del arma. Rifle: cuerpo a
    82 Hz, sub a 48 Hz, chasquido a 1400 Hz. Medido en Chrome renderizando cada
    disparo con `OfflineAudioContext` (banco: `audio-preview.html`), ocho
    disparos por arma:
    | | rifle antes | rifle ahora | pistola antes | pistola ahora |
    |---|---|---|---|---|
    | centroide espectral | 1478 Hz | 521 Hz | 1701 Hz | 708 Hz |
    | energía en 20-60 Hz | 0,5% | 29,2% | 0% | 9,1% |
    | energía por encima de 160 Hz | 39% | 46% | 79% | 47% |
    | cola audible | 249 ms | 442 ms | 170 ms | 189 ms |
    | pico (volumen al máximo) | 0,89 | 0,72 | 0,78 | 0,60 |
    | pico de la ráfaga a cadencia real | 1,03 (satura) | 0,90 | 0,79 | 0,81 |
    La energía por encima de 160 Hz **sube** en el rifle (39% → 46%), que es el
    seguro contra pasarse de graves: aunque un portátil se coma el sub entero,
    queda más disparo que antes. De paso, la ráfaga del rifle ya no satura.
  - **Ojo con esto:** la correlación media entre disparos sube de 0,28 a 0,50
    (media de los 28 pares). Es inherente a que ahora manda una capa tonal grave
    y no el ruido; se ha compensado ampliando el detune a ±8% y variando también
    el peso del sub, pero si al escucharlo una ráfaga suena a copia y pega, ahí
    está la causa.
  - **Falta la escucha en altavoces y en auriculares**, que es el criterio de
    arriba y no se puede cerrar desde aquí. Los WAV de las dos versiones
    (suelto y ráfaga a la cadencia real de cada arma) salen del banco con
    `audio-preview.html`.

- [x] **T01. Pasos audibles del rival**
  Hoy solo se oyen los pasos propios: el rival se mueve en silencio absoluto, y en
  un juego de duelos el sonido *es* información. El evento `step` ya está definido
  en el protocolo pero no lo emite nadie (código muerto que esta tarea resuelve).
  - Dónde: emitir desde [session.ts](apps/server/src/session.ts) cuando un jugador
    supera cierta velocidad en el suelo, con cadencia dependiente de la velocidad;
    consumirlo en [game.ts](apps/client/src/game/game.ts).
  - Andar con `Shift` ya reduce la velocidad: debe dejar de generar pasos, que es
    lo que hace útil andar despacio.
  - Hecho cuando: hay test de que correr genera pasos a ritmo constante, que
    agacharse o andar no los genera, y que un jugador quieto tampoco.
  - **Hecho (2026-09-03).** La regla vive en `advanceFootstep`
    ([movement.ts](packages/shared/src/movement.ts)) y la usan los dos lados: el
    servidor la emite para todo el mundo y el cliente la predice para los pasos
    propios, porque oir el propio paso con un RTT de retraso se nota. Va por
    **distancia recorrida y no por tiempo**, asi que la cadencia sale sola de la
    velocidad sin ninguna formula aparte.
  - El umbral (`FOOTSTEP_MIN_SPEED`) se define desde `WALK_SPEED_MULTIPLIER` y no
    como numero suelto: andar tiene que ser silencioso siempre, asi que si se
    retoca lo que corre alguien andando, el umbral lo sigue. De paso arregla que
    el jugador se oyera a si mismo al andar (el cliente usaba un umbral de 100,
    por debajo de los 130 de andar).
  - La zancada **no se reinicia al pararse**, a proposito: si se reiniciase,
    avanzar a tirones cortos seria una forma gratuita de cruzar el mapa en
    silencio. Hay test de eso.
  - Verificado ademas en Chrome contra el servidor real: en 30 s de partida
    contra el bot llegan 33 eventos `step` del rival, sin errores de consola. El
    bot corre por encima del umbral en el 51% de las instantaneas y su punta es
    de 216 u/s, que cuadra con las ~40 zancadas teoricas.

- [x] **T02. Sonido posicional real**
  El audio solo atenúa por distancia ([audio.ts](apps/client/src/audio.ts)): un
  disparo a la espalda suena igual que uno de frente. Con `PannerNode` (HRTF) y la
  orientación de la cámara se sabría de dónde viene, que junto a T01 es la mitad
  del juego de información.
  - Hecho cuando: los sonidos con posición se emiten por un `PannerNode` orientado
    con la vista del jugador, y hay un test de la conversión de coordenadas del
    juego (Z-up) a las del listener de WebAudio (Y-up).
  - **Hecho (2026-09-03).** `play(name, at?)` pasa a recibir la posición del mundo
    en vez de una distancia ya calculada; con posición va por un `PannerNode` con
    HRTF, y sin ella suena plano (avisos, arma propia, muerte propia). El oyente
    se coloca cada fotograma con la cámara, **sin el retroceso**: mover la vista
    unos grados al disparar no debe hacer bailar los sonidos.
  - La atenuación por distancia **sigue siendo la de siempre** (`1/(1+d/900)`, en
    su nodo de ganancia) y el panner va con `rolloffFactor` a 0. Así añadir
    dirección no cambia de paso el equilibrio de volúmenes ya ajustado.
  - La conversión Z-arriba → Y-arriba vive en
    [spatial.ts](apps/client/src/spatial.ts) con 9 tests, incluido uno de que la
    conversión **no invierte la mano**: es un giro, no una reflexión, que es lo
    que evita el fallo de que un disparo por la izquierda suene por la derecha.
  - Comprobado en Chrome renderizando en estéreo con `OfflineAudioContext`: una
    fuente a la izquierda del jugador da 0,0283 de RMS en el canal izquierdo
    frente a 0,0196 en el derecho, a la derecha se invierte, de frente queda
    centrada, y **el mismo punto del mundo cambia de oído al girarse 180º**. Un
    sonido a la espalda sale un 26% más flojo que de frente, que es la
    diferencia delante/detrás que da el HRTF.
  - De paso: las posiciones de los eventos se sacan de la instantánea y no del
    avatar interpolado, y si un jugador ya no está en ella el sonido no se
    reproduce, en vez de sonar plano y a todo volumen.

- [ ] **T03. Cámara de muerte**
  Al morir la vista se queda congelada donde estaba. Debería girar hacia quien te
  mató y seguirle hasta el fin de la ronda: informa de dónde vino el disparo y
  quita la sensación de corte seco.
  - Hecho cuando: al morir la cámara interpola hacia el asesino y le sigue; si la
    muerte fue por caída, se queda mirando el punto de impacto.

- [ ] **T04. Marcador y resumen de partida**
  No hay forma de ver el estado más allá de los dos números de arriba. Falta un
  panel con `Tab` (rondas ganadas, bajas, precisión) y una pantalla de fin de
  partida antes de volver al menú.
  - Requiere llevar la cuenta de disparos y aciertos por jugador en el servidor.
  - Hecho cuando: el servidor envía las estadísticas en la instantánea, `Tab` las
    muestra, y hay test de que la precisión se calcula sobre disparos realizados.

---

## P2 — Profundidad de juego

- [ ] **T05. Tercera arma con mira (rifle de precisión)**
  Dos armas dan poca decisión. Un rifle de un disparo con zoom obliga a elegir
  entre control del ángulo largo y movilidad, que es la tensión que hace
  interesante el mapa.
  - Necesita apuntado: FOV reducido, sensibilidad escalada con el zoom (si no, la
    mira se vuelve inmanejable) y penalización de velocidad al apuntar.
  - Hecho cuando: existe en [weapons.ts](packages/shared/src/weapons.ts) con sus
    tests de daño y dispersión, el zoom es parte del comando de usuario (o el
    servidor no podría validar la precisión) y se predice sin tirones.

- [ ] **T06. Economía por rondas**
  Ganar o perder una ronda no tiene consecuencia en la siguiente. Un dinero simple
  (recompensa por ronda y por baja, compra en la fase de congelación) crea
  decisiones entre rondas.
  - Hecho cuando: la fase `freeze` permite comprar, el dinero se simula en el
    servidor y hay tests de las reglas de recompensa.

- [ ] **T07. Segundo mapa**
  `ATRIUM` es una arena abierta. Un mapa con pasillos y ángulos cerrados prueba
  que el motor no está atado a un solo diseño, y de paso obligará a mejorar al bot.
  - La definición ya lo admite sin tocar el motor: ver [map.ts](packages/shared/src/map.ts).
  - Hecho cuando: el mapa pasa los mismos tests que `ATRIUM` (simetría, spawns no
    sólidos, rutas transitables) y se puede elegir al crear la partida.

- [ ] **T08. Avatares animados**
  Los rivales se deslizan rígidos. Con inclinación al correr y balanceo de piernas
  derivados de la velocidad interpolada, sin esqueleto ni assets, se lee mucho
  mejor lo que están haciendo.
  - Hecho cuando: el avatar refleja velocidad, dirección y salto en
    [players.ts](apps/client/src/render/players.ts).

- [ ] **T09. Bot con navegación**
  El bot persigue en línea recta y rodea cuando detecta que no avanza
  ([bot.ts](apps/server/src/bot.ts)). Le basta para una arena abierta; con T07 se
  quedará atascado. Un grafo de puntos de navegación por mapa y búsqueda de camino
  lo arregla sin complicarlo mucho.
  - Hecho cuando: el bot llega a cualquier punto del mapa desde cualquier otro en
    un test, con un límite de tiempo razonable.

---

## P3 — Infraestructura y sostenibilidad

- [ ] **T10. ESLint + Prettier**
  No hay linter. El estilo hoy es consistente porque se escribió de una vez; en
  cuanto se toque desde varias sesiones dejará de serlo.
  - Reglas mínimas: `@typescript-eslint` estricto, prohibir `any` implícito y
    exportaciones sin uso, formato con Prettier.
  - Hecho cuando: `npm run lint` está en verde, entra en `npm run check` y en CI.

- [ ] **T11. El servidor mide la latencia**
  Hoy el cliente declara su `rtt` y el servidor lo usa para rebobinar. Está acotado
  a 200 ms, así que el abuso posible es pequeño, pero medirlo en el servidor a
  partir del retraso de los comandos recibidos elimina el problema de raíz.
  - Hecho cuando: `computeRewindTime` usa una latencia estimada por el servidor y
    hay test de que un cliente que miente no consigue más rebobinado.

- [ ] **T12. Reconexión**
  Si se cae el socket se pierde la partida. Guardar la sesión unos segundos con un
  identificador permitiría volver a la ronda en curso.
  - Hecho cuando: un cliente que se reconecta con su identificador recupera su
    jugador, y hay test de que la sesión expira si no vuelve.

- [ ] **T13. Instantáneas delta**
  Se envía el estado completo 64 veces por segundo. Con dos jugadores son ~15 KB/s
  y no molesta, pero mandar solo lo que cambia (o bajar a 32 Hz apoyándose en la
  interpolación) es la mitad del tráfico casi gratis.
  - Medir antes y después: sin número no es una optimización, es una corazonada.
  - Hecho cuando: el cliente reconstruye el estado a partir de deltas y hay test de
    que una secuencia con deltas produce el mismo estado que una completa.

- [ ] **T14. Ajustes de mira y teclas**
  Los enlaces de teclado están en el código
  ([input.ts](apps/client/src/game/input.ts)) y la mira no se puede configurar.
  Ambas cosas son de las primeras que toca cualquiera que juegue en serio.
  - Hecho cuando: se pueden reasignar teclas y ajustar color, grosor y modo
    (estática o dinámica) de la mira, todo persistido con el resto de ajustes.

- [ ] **T15. Docker y observabilidad**
  Para desplegarlo en algún sitio hacen falta una imagen y métricas mínimas
  (partidas activas, tick real, jugadores conectados) en el endpoint de salud.
  - Hecho cuando: `docker build` produce una imagen que arranca el juego, y
    `/health` informa del tick real medido, no del teórico.

- [ ] **T16. Rendimiento del render**
  Cada brush es una malla ([world.ts](apps/client/src/render/world.ts)). Con ~70
  va sobrado, pero un mapa mayor pediría fusionar la geometría estática por
  material. Medir primero con las herramientas del navegador.
  - Hecho cuando: hay una medida antes y después en un mapa grande de prueba.

---

## Decisiones ya tomadas (no revertir sin motivo)

Cosas que parecen mejorables pero son deliberadas. Si una iteración futura quiere
cambiarlas, que sea a propósito y no por descuido:

- **Sin nombres sobre el rival.** Delataría una posición que el jugador no debería
  conocer.
- **JSON en el protocolo.** Con dos jugadores el coste es irrelevante y depurar a
  ojo vale más. Ver T13 antes de saltar a binario.
- **Unidades de Source (1 unidad ≈ 1,9 cm).** Las constantes de movimiento están
  calibradas en esa escala; cambiar a metros obligaría a recalibrarlo todo.
- **El bot vive en el servidor y no predice.** No es un cliente simulado: su única
  ventaja es no tener latencia, y se compensa con error de puntería y tiempo de
  reacción explícitos.
- **La primera bala es exacta.** El patrón de retroceso empieza en cero a
  propósito: es lo que hace que el primer disparo sea una decisión y no una
  lotería.
- **La simulación no consulta el reloj.** Todo avanza por pasos explícitos. Es lo
  que permite simular una partida entera en milisegundos en los tests; cualquier
  `Date.now()` dentro de la simulación rompe esa propiedad.
