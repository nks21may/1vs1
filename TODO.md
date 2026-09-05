# Backlog de NEONDUEL

Lista de mejoras pensada para trabajarse **de una en una**, en sesiones cortas e
independientes. Cada tarea es autocontenida: dice qué hacer, por qué merece la
pena, dónde tocar y cuándo se considera terminada.

---

## Cómo iterar sobre este archivo

Una iteración = **una tarea completa**, no media. El ciclo es siempre el mismo:

1. Coger la primera tarea sin marcar de la prioridad más alta que quede,
   **saltando las marcadas `⏸ EN PAUSA` o `❓ POR DEFINIR`** (ver abajo).
2. Implementarla entera, con sus tests.
3. `npm run check` (typecheck + toda la batería) en verde.
4. Si toca al cliente, comprobarlo en el navegador de verdad, no solo por tests.
5. Marcar la casilla y anotar en una línea qué se hizo, si se desvió del plan.

Los identificadores (`T01`, `T02`...) son etiquetas estables para poder
referenciarlas, no un orden de ejecución: el orden es el de la lista.

**`❓ POR DEFINIR` tampoco se coge.** Es una tarea pedida pero sin alcance: falta
decidir qué es. Implementarla a ojo es inventarse el encargo, así que se salta
igual que una en pausa hasta que alguien escriba su criterio de "hecho".

**`⏸ EN PAUSA` no es lo mismo que "sin hacer".** Una tarea en pausa lo está
porque alguien decidió que no se haga, no porque nadie haya llegado a ella:
saltarla es lo correcto y no hay que anotar nada al respecto. Solo se quita la
pausa si lo pide quien la puso.

Para automatizarlo:

```
/loop Coge la primera tarea sin marcar de TODO.md que no esté EN PAUSA,
impleméntala entera con sus tests, deja `npm run check` en verde y marca la
casilla. Una sola tarea por
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

- [ ] **T19. Strafe** — ❓ **POR DEFINIR (pedida el 2026-09-04 por Nicolás).**
  No la cojas en una iteración automática hasta que tenga alcance: implementarla
  a ojo es lo mismo que inventarse el encargo.
  **Lo que ya existe** (y por eso hace falta concretar): el air-strafing con
  aceleración de Quake, el counter-strafe que frena en seco por debajo de
  `STOP_SPEED`, y el bunnyhop con ventana de 150 ms y techo relativo al arma.
  Están en [movement.ts](packages/shared/src/movement.ts), documentados en el
  README y con tests que comprueban altura de salto, frenada y cadena de saltos.
  - Lecturas posibles de "añadir strafe", por si alguna es la buena:
    - **Aprenderlo**: hoy no hay forma de saber si strafeas bien. El HUD tiene
      velocidad, pero no dice cuánta ganas por salto ni si el girón llega tarde.
      Un indicador de calidad del strafe (ganancia por salto, ángulo óptimo) o un
      modo de práctica sería contenido nuevo de verdad.
    - **Surf**: deslizarse por rampas inclinadas. Hoy imposible sin tocar el
      motor: la colisión es solo de cajas alineadas a los ejes, y admitir planos
      inclinados es un cambio grande en `collision.ts`.
    - **Que el avatar se incline al strafear**, que en realidad es parte de T08.
    - **Otra cosa**: si el strafe se siente mal jugando, decir en qué se nota
      (no gana velocidad, gira raro, se pierde al aterrizar) y eso ya es la tarea.
  - Hecho cuando: esté escrito aquí qué de lo anterior es, con su criterio propio.

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

- [x] **T03. Cámara de muerte**
  Al morir la vista se queda congelada donde estaba. Debería girar hacia quien te
  mató y seguirle hasta el fin de la ronda: informa de dónde vino el disparo y
  quita la sensación de corte seco.
  - Hecho cuando: al morir la cámara interpola hacia el asesino y le sigue; si la
    muerte fue por caída, se queda mirando el punto de impacto.
  - **Hecho (2026-09-03).** La lógica está en
    [deathcam.ts](apps/client/src/game/deathcam.ts) con 8 tests. La cámara arranca
    en los ángulos que tenía el jugador al morir, para que el giro se vea salir de
    su propia vista, sube 28 unidades sobre el cuerpo y apunta al pecho del
    asesino (a los pies dejaría la cámara mirando al suelo cuando está cerca).
  - El suavizado es exponencial (`1 - e^(-k·dt)`) y no un paso lineal: así el giro
    tarda lo mismo a 30 que a 240 fps **y no se pasa nunca de largo**, ni siquiera
    con el `dt` enorme que devuelve una pestaña que estaba en segundo plano. Hay
    test de las dos cosas.
  - Sin asesino (una caída) mira al punto de impacto, que queda justo debajo: la
    cámara acaba mirando a plomo hacia el cuerpo.
  - Se cancela al volver a estar vivo, no solo al empezar la ronda, para que
    cualquier otra forma de reaparecer no deje la vista clavada en el asesino.
  - Verificado en partida real contra el bot difícil: muerte en (1056, 0, 96) con
    el asesino en (480, -333, 0); a los 0,08 s el bot está abajo a la izquierda de
    la mira y a los 0,7 s ya está centrado. En la ronda siguiente la vista vuelve
    a ser la del jugador. Sin errores de consola.

- [x] **T04. Marcador y resumen de partida**
  No hay forma de ver el estado más allá de los dos números de arriba. Falta un
  panel con `Tab` (rondas ganadas, bajas, precisión) y una pantalla de fin de
  partida antes de volver al menú.
  - Requiere llevar la cuenta de disparos y aciertos por jugador en el servidor.
  - Hecho cuando: el servidor envía las estadísticas en la instantánea, `Tab` las
    muestra, y hay test de que la precisión se calcula sobre disparos realizados.
  - **Hecho (2026-09-03).** El servidor lleva `kills`, `deaths`, `shots` y `hits`
    por jugador y los manda en cada `PlayerSnapshot`. `Tab` abre el marcador
    mientras se mantiene, y al acabar la partida sale un resumen con el mismo
    cuadro y un botón para volver al menú.
  - **El disparo se cuenta antes de saber en qué acaba**, que es lo que hace que
    la punteria signifique algo: fallar contra una pared entra en el denominador.
    Hay test de las dos caras (cinco disparos al aire = 0%, uno acertado = 100%)
    y del caso sin disparos, que da 0 y no una división por cero.
  - Las estadísticas son **de la partida, no de la sesión**: entrar en
    calentamiento las pone a cero, o la punteria de la siguiente partida saldría
    falseada. Con test.
  - Caerse al vacío suma muerte pero no baja a nadie.
  - Verificado en partida real contra el bot difícil: el marcador aparece y
    desaparece con `Tab`, y el resumen final dio bot 8 rondas / 8 bajas / **25% de
    punteria** y jugador 0 disparos / **0%** — justo las dos propiedades que
    importaban, medidas sobre datos reales y sin errores de consola.
  - Ojo para más adelante: las estadísticas viajan en cada instantánea aunque
    casi nunca cambien. Con dos jugadores y JSON da igual; si alguna vez se hace
    el delta de T13, esto es candidato claro a no repetirse.

---

## P2 — Profundidad de juego

- [x] **T05. Tercera arma con mira (rifle de precisión)**
  Dos armas dan poca decisión. Un rifle de un disparo con zoom obliga a elegir
  entre control del ángulo largo y movilidad, que es la tensión que hace
  interesante el mapa.
  - Necesita apuntado: FOV reducido, sensibilidad escalada con el zoom (si no, la
    mira se vuelve inmanejable) y penalización de velocidad al apuntar.
  - Hecho cuando: existe en [weapons.ts](packages/shared/src/weapons.ts) con sus
    tests de daño y dispersión, el zoom es parte del comando de usuario (o el
    servidor no podría validar la precisión) y se predice sin tirones.
  - **Hecho (2026-09-03).** LONGWAVE: un tiro por pulsación, 1 s de ciclo, 115 de
    daño (mata al cuerpo, **no a las piernas**), cargador de 5 y sin caída de
    daño útil. Con ella encima se corre menos que con el rifle (0,72 frente a
    0,86), y apuntar deja al jugador al 42% de eso.
  - `BUTTON.AIM` va **en el comando**, y `player.aiming` es estado simulado: el
    servidor lleva el apuntado por su cuenta y calcula con él la dispersión y la
    velocidad, así que no hay nada que el cliente pueda afirmar sobre su propia
    precisión. Cambiar a un arma sin mira lo cancela solo.
  - **Apuntar afina solo la dispersión base, no la penalización por moverse.** La
    primera versión multiplicaba el total y dejaba el arma en 0,12° corriendo y
    apuntando, es decir, puntero fino en movimiento: justo lo contrario de la
    decisión entre ángulo largo y movilidad que la tarea busca. Con el cambio,
    quieto y apuntando son 0,04° y en carrera 7°. Hay test de las dos cosas.
  - La sensibilidad se escala con el zoom real (no con el objetivo), así que
    también responde bien durante la transición. El suavizado del FOV es solo
    visual: la simulación considera que se apunta desde el primer tick, o la
    precisión dependeria de una animación.
  - El cambio de arma pasa a ser un ciclo de tres. Silueta y sonido propios: la
    del visor y el cañón largo, y un disparo más grave y con el doble de cola que
    el del rifle. **El ciclo ya no existe** (ver B01): hay una tecla por arma.
  - Verificado en partida real: el servidor confirma `weapon: sniper`, apuntar
    lleva el FOV de 74° a 28° y cierra la mira, y no hay errores de consola.

- [ ] **T06. Economía por rondas** — ⏸ **EN PAUSA (2026-09-03, decisión de Nicolás).**
  No la cojas en ninguna iteración automática: está aparcada a propósito, no
  pendiente. Si un loop llega hasta aquí, saltar a la siguiente sin marcarla.
  Ganar o perder una ronda no tiene consecuencia en la siguiente. Un dinero simple
  (recompensa por ronda y por baja, compra en la fase de congelación) crea
  decisiones entre rondas.
  - Hecho cuando: la fase `freeze` permite comprar, el dinero se simula en el
    servidor y hay tests de las reglas de recompensa.

- [x] **T07. Segundo mapa**
  `ATRIUM` es una arena abierta. Un mapa con pasillos y ángulos cerrados prueba
  que el motor no está atado a un solo diseño, y de paso obligará a mejorar al bot.
  - La definición ya lo admite sin tocar el motor: ver [map.ts](packages/shared/src/map.ts).
  - Hecho cuando: el mapa pasa los mismos tests que `ATRIUM` (simetría, spawns no
    sólidos, rutas transitables) y se puede elegir al crear la partida.
  - **Hecho (2026-09-03).** `CONDUIT`: tres carriles paralelos separados por muros
    macizos, sin altura y sin ángulos largos. Un bloque central tapa la línea entre
    spawns, los huecos que comunican los carriles quedan en la mitad de cada uno
    con una esquina ciega al lado, y un pilar parte cada pasillo (si no, serían dos
    rectas de 2300 unidades y el LONGWAVE no tendría rival).
  - Los invariantes de mapa **pasaron a ser table-driven sobre `MAPS`**: simetría,
    volumen positivo, límites, spawns fuera de la geometría, suelo firme, sin
    línea de tiro entre spawns y muros que encierran. Un mapa nuevo que incumpla
    algo rompe la batería el día que se añade, no el día que alguien se cae.
  - "Rutas transitables" se comprueba con una **búsqueda en anchura** sobre las
    posiciones donde el jugador cabe, no con un camino escrito a mano: un camino a
    mano solo prueba ese camino.
  - **Bug encontrado por el camino:** el cliente tenía `ATRIUM` fijo tanto para la
    malla como para la geometría contra la que predice. Elegir otro mapa habría
    hecho que el jugador viera un mapa y chocara con otro. Ahora el mapa lo fija el
    `welcome` del servidor y el cliente rehace las dos cosas (liberando la malla
    anterior, o cambiar de mapa entre partidas iba dejando geometrías en la GPU).
  - Se elige en el menú; viaja como `?map=` y el servidor ignora un nombre que no
    conozca en lugar de tumbar la conexión. El bot navega el mapa que se juega, que
    antes era siempre el de por defecto.
  - Verificado en partida real con los dos: el `welcome` devuelve el mapa pedido,
    ambos se recorren andando (380 y 400 unidades en 2,5 s) y no hay errores de
    consola.

- [x] **T08. Avatares animados**
  Los rivales se deslizan rígidos. Con inclinación al correr y balanceo de piernas
  derivados de la velocidad interpolada, sin esqueleto ni assets, se lee mucho
  mejor lo que están haciendo.
  - Hecho cuando: el avatar refleja velocidad, dirección y salto en
    [players.ts](apps/client/src/render/players.ts).
  - **Hecho (2026-09-04).** Sin esqueleto ni assets: la pose sale de la velocidad
    interpolada, que el cliente ya tiene. La cuenta está aparte del render en
    [avatar-pose.ts](apps/client/src/render/avatar-pose.ts), con 10 tests, porque
    es lo único del render que se puede comprobar sin WebGL.
  - El bloque único de piernas pasa a ser **dos piernas colgadas de la cadera**,
    para que pivoten desde arriba y no desde el suelo.
  - **La zancada avanza con la distancia recorrida, no con el tiempo**, que es lo
    que evita que los pies patinen al ir despacio. El ciclo mide 168 unidades,
    justo el doble de la zancada de los pasos audibles (T01), así que lo que se ve
    y lo que se oye van al mismo ritmo en vez de cada uno por su lado. Hay test de
    que la misma distancia deja la fase en el mismo sitio con `dt` grande o
    pequeño.
  - En el aire se recogen las piernas y **la fase se congela**, para que al
    aterrizar la zancada siga donde estaba en lugar de pegar un salto.
  - La inclinación es invariante al `yaw` (correr de frente es correr de frente
    mire donde mire), y el alabeo sigue al lado hacia el que se desplaza. Con test.
  - Verificado con un banco propio (`avatar-preview.html`) que pone los cuatro
    casos en fila: parado, corriendo, de lado y en el aire. El alabeo lateral se
    ve mal desde el perfil que usa el banco; esa parte la cubren los tests.

- [x] **T09. Bot con navegación**
  El bot persigue en línea recta y rodea cuando detecta que no avanza
  ([bot.ts](apps/server/src/bot.ts)). Le basta para una arena abierta; con T07 se
  quedará atascado. Un grafo de puntos de navegación por mapa y búsqueda de camino
  lo arregla sin complicarlo mucho.
  - Hecho cuando: el bot llega a cualquier punto del mapa desde cualquier otro en
    un test, con un límite de tiempo razonable.
  - **Hecho (2026-09-04).** [navigation.ts](packages/shared/src/navigation.ts)
    construye un grafo de rejilla (32 unidades) barriendo el mapa con la **misma
    colisión que usa la simulación**: un mapa nuevo trae su navegación sin que
    nadie anote nada, que es la única forma de que no se quede desfasada cuando
    alguien mueve una pared. La separación de 32 no es arbitraria: con 64, dos
    nodos seguidos de una escalera se llevarían más de `STEP_SIZE` y las escaleras
    quedarían marcadas como intransitables.
  - El barrido también encuentra sitio de pie **encima** de los muros y del
    monolito. Son posiciones válidas a las que no se llega, así que el grafo se
    recorta a lo alcanzable desde los spawns: así es de una pieza por
    construcción y no hay que preguntarse si un camino existe. Con test de que los
    tejados quedan fuera y el balcón de ATRIUM dentro.
  - El bot **apunta a un sitio y camina hacia otro**, como un jugador: el rumbo se
    traduce a las teclas relativas a dónde mira. Eso permitió borrar el rodeo a
    tientas (temporizadores de progreso y de esquiva) que existía antes.
  - Dos ajustes salieron de verlo fallar, no de pensarlo: el radio de waypoint
    tiene que ser **menor que la separación del grafo** (22 < 32) o el bot corta
    camino entre nodos y acaba encajado en el costado de una escalera; y al
    atascarse **salta**, que es lo que resuelve quedarse trabado en el canto de un
    escalón.
  - Verificado con física real, no solo sobre el grafo: el bot va de spawn a spawn
    y a los cuatro extremos de cada mapa (y vuelve) en menos de 25 s; el peor caso
    son 17. En una partida real en CONDUIT recorre 7278 unidades en 40 s, encuentra
    al rival por los pasillos y le baja la vida.

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

- [ ] **T15. Docker y observabilidad** — la imagen ya está (2026-09-04); falta la
  observabilidad.
  `Dockerfile`, `compose.yaml` y [DEPLOY.md](DEPLOY.md) construyen la imagen en
  x86_64 y en ARM64 y la dejan lista para servir detrás de un túnel o un proxy.
  Lo que sigue pendiente son las métricas: `/health` solo informa de las sesiones
  vivas y de la versión del protocolo, y el tick que anuncia el `welcome` es el
  teórico, no el que el bucle consigue de verdad.
  - Hecho cuando: `/health` informa del tick real medido, de los jugadores
    conectados y de las partidas activas.

- [ ] **T16. Rendimiento del render**
  Cada brush es una malla ([world.ts](apps/client/src/render/world.ts)). Con ~70
  va sobrado, pero un mapa mayor pediría fusionar la geometría estática por
  material. Medir primero con las herramientas del navegador.
  - Hecho cuando: hay una medida antes y después en un mapa grande de prueba.

---

## Arreglos de bugs reportados en partida

Los pidió Nicolás el 2026-09-04 jugando, no salieron de este backlog. Se anotan
aquí porque dos de ellos cambiaron reglas del juego, no solo código.

- [x] **B01. Una tecla por arma, sin ciclo**
  `Digit2` estaba enlazada al mismo botón que `Q` y ese botón *rotaba* de arma,
  así que una pulsación larga o la repetición del teclado encadenaba cambios y se
  acababa con un arma que nadie había pedido.
  - El botón `SWITCH` desaparece del comando. En su lugar viaja un campo `slot`
    (1-4) que dice *qué* arma se quiere, no "cambia": pedir la que ya se lleva no
    hace nada, así que mantener la tecla es inofensivo por construcción y no hay
    que detectar el flanco de la pulsación.
  - `1` rifle, `2` pistola, `3` cuchillo, `4` sniper. `PROTOCOL_VERSION` sube a 2:
    un cliente viejo en caché no podría cambiar de arma, y es mejor que lo rechace.

- [x] **B02. La cámara temblaba al moverse agachado**
  Dos causas encadenadas, las dos arregladas:
  - Al quedarse sin comandos (los huecos son constantes con el jitter normal), el
    servidor repetía el último con `buttons: 0`, o sea **levantaba** a un jugador
    que seguía agachado en su pantalla. La velocidad máxima simulada saltaba de 73
    a 215 u/s varias veces por segundo y la corrección resultante sacudía la vista.
    Ahora el comando repetido conserva los botones de postura (`HELD_BUTTONS`).
  - El `duckProgress` no viajaba en la instantánea, así que el cliente lo deducía
    del bit `DUCKING`: 0 o 1, nunca la transición. Cualquier corrección a media
    bajada movía la cámara 18 unidades de golpe. Ahora se envía el progreso.

- [x] **B03. Cuchillo en la tecla 3**
  SPLICE: cuerpo a cuerpo, ×1,16 de velocidad (lo más rápido del juego), 76
  unidades de alcance, dos tajos al cuerpo o uno a la cabeza. La sniper pasa al
  `4`. No gasta munición ni se recarga: `WeaponDef.melee` decide eso, el clic en
  vacío y el `∞` del HUD.

- [x] **B04. Bunnyhop con aviso sonoro**
  - **Bug latente que salió por el camino:** el evento `landed` no se emitía
    *nunca*. Se decidía antes de mover al jugador en ese tick, así que cayendo
    siempre lo veía todavía en el aire. Por eso no sonaba el golpe al aterrizar ni
    se aplicaba la penalización por caída fuerte. Ahora se decide después del
    último `categorizePosition`, que es el que ve el contacto de verdad.
  - Regla: saltar dentro de los 150 ms siguientes al contacto conserva la
    velocidad; fuera de ella se recorta a ×1,1 de la carrera. Dentro de la ventana
    el suelo no aplica fricción, y **eso es lo que hace jugable la mecánica**: con
    fricción, dos ticks se comen lo ganado en el aire y solo valdría el salto en
    el tick exacto del contacto (15 ms), imposible de acertar de oído.
  - Techo relativo al arma (×1,7 de *su* carrera): 306 con la sniper, 365 con el
    rifle, 441 con el cuchillo. Con un techo absoluto, el bhop borraría los
    multiplicadores de velocidad de las armas.
  - Aviso: un clic agudo 130 ms antes del aterrizaje previsto (`timeToLanding`,
    balística pura contra el suelo de debajo). Con una ventana de 150 ms valen las
    reacciones de 130 a 280 ms. Un tono ascendente confirma el salto que entró.
    Se puede apagar en los ajustes.
  - Medido encadenando saltos con air-strafe desde 250 u/s: 250 → 270 → 289 → 307
    → ... hasta el techo. Con 12 ticks de retraso (187 ms) la cadena se rompe y la
    velocidad cae por debajo de 150.

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
- **Una tecla por arma, no un ciclo.** Y la petición viaja como "quiero esta
  arma", no como "cambia": es lo que hace que mantener la tecla sea inofensivo sin
  necesidad de detectar flancos. Ver B01.
- **Dentro de la ventana de bhop el suelo no da fricción.** Parece una excepción
  gratuita en la física y es justo lo contrario: sin ella la ventana de 150 ms es
  decorativa y la única forma de encadenar sería acertar el tick exacto del
  contacto. Ver B04.
- **El comando que el servidor se inventa conserva la postura.** Cuando el buffer
  de entrada se queda vacío se repite el último comando sin *acciones* (disparar,
  moverse, saltar) pero con la *postura* (agachado, andando, apuntando). Borrarla
  entera separaba las dos simulaciones varias veces por segundo. Ver B02.
- **La simulación no consulta el reloj.** Todo avanza por pasos explícitos. Es lo
  que permite simular una partida entera en milisegundos en los tests; cualquier
  `Date.now()` dentro de la simulación rompe esa propiedad.
- **La imagen de Docker no lleva `node_modules`.** El servidor se publica como el
  bundle de esbuild más `ws`, que es lo único que queda fuera. Copiar el árbol
  entero traería `three` y el resto de dependencias del cliente, que en tiempo de
  ejecución no pinta nada.
