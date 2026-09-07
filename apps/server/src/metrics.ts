/**
 * Medida del ritmo real del bucle.
 *
 * El servidor simula a paso fijo, asi que su tick nominal siempre es 64 Hz: lo
 * que puede fallar no es el tamano del paso, sino cuantos consigue dar por
 * segundo. Si la maquina se queda corta, o el proceso se para un momento, los
 * clientes reciben menos instantaneas de las que creen y no hay nada en los
 * logs que lo diga.
 *
 * Se cuenta por ventanas cerradas de un segundo y no por la distancia entre
 * ticks: el bucle recupera el retraso simulando varios de golpe, todos con la
 * misma marca de tiempo, y eso haria dividir por cero.
 */

/** Ventana de medida. Un segundo es lo que se lee en un `/health` a ojo. */
const WINDOW_MS = 1000;

export class TickMeter {
  private count = 0;
  private windowStart: number | null = null;
  private measured: number | null = null;

  /** Anota un tick simulado. `nowMs` es el reloj de pared, no el simulado. */
  record(nowMs: number): void {
    // El primero solo abre la ventana. Lo que se cuenta son los intervalos
    // entre ticks, no las marcas: contando marcas, una ventana de un segundo a
    // 64 Hz tendria 65 y la medida saldria siempre un tick larga.
    if (this.windowStart === null) {
      this.windowStart = nowMs;
      return;
    }
    this.count += 1;

    const elapsed = nowMs - this.windowStart;
    if (elapsed < WINDOW_MS) return;

    this.measured = (this.count * 1000) / elapsed;
    this.count = 0;
    this.windowStart = nowMs;
  }

  /**
   * Ticks por segundo de la ultima ventana cerrada, o `null` mientras no haya
   * ninguna. Es a proposito: un `0` diria que el bucle esta parado, que es una
   * afirmacion muy distinta de "todavia no lo se".
   */
  get hz(): number | null {
    return this.measured === null ? null : Math.round(this.measured * 10) / 10;
  }
}
