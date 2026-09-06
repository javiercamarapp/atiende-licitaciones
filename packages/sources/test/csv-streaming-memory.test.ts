import { describe, expect, it } from "vitest";
import { parseComprasMxHistoricoCsvStreamed } from "../src/connectors/compras-mx/comprasmx-mapper.js";

/**
 * Mejora de memoria (ronda 3 de corrección, ver docs/auditoria-1/sources-cierre.md
 * §CSV histórico): la reverificación adversarial 2 midió, para el parser
 * ANTERIOR (`parseComprasMxHistoricoCsv`, que arma el archivo completo como
 * una sola cadena y el arreglo completo de `TenderRecord` antes de devolver
 * el primero), un heap delta de **2318.8 MB para un archivo simulado de
 * 50 MB (46.38x de multiplicación)** -- extrapolado al archivo REAL
 * (~951 MB) eso son ~44 GB de heap, inviable en cualquier entorno de
 * producción realista.
 *
 * Este test procesa el MISMO volumen (~50 MB) a través del parser en
 * STREAMING (`parseComprasMxHistoricoCsvStreamed`, ver `util/csv.ts`
 * `CsvRowStreamParser`/`streamCsvRows`) y confirma que el crecimiento de
 * heap NO escala con el tamaño del archivo: se mantiene por debajo de un
 * múltiplo pequeño de un "lote" (chunk) de referencia, en vez de acercarse
 * al tamaño del archivo completo. El CSV de 50 MB se genera de forma
 * perezosa (chunk por chunk, `generateCsvChunks()` abajo) -- la cadena
 * completa de 50 MB NUNCA existe como un solo valor en memoria durante este
 * test, ni del lado del "productor" ni del "consumidor" (el parser).
 *
 * Límite real documentado (honesto, no ideal): sin forzar una recolección
 * de basura explícita (`--expose-gc`, no garantizado en todos los entornos
 * de CI), el heap medido por `process.memoryUsage()` incluye basura aún no
 * recolectada, no solo memoria realmente retenida -- por eso el umbral
 * (5x un lote de referencia de 2 MiB = 10 MiB) es generoso frente al ideal
 * teórico (que sería ~O(1 fila)), pero sigue siendo más de 230x más
 * estricto que el multiplicador de 46.38x aplicado al archivo COMPLETO que
 * medía el parser anterior -- suficiente para demostrar que la memoria ya
 * no escala con el tamaño del archivo.
 */
describe("Memoria acotada del parser CSV en streaming (mejora de memoria, ronda 3 de corrección)", () => {
  it("procesa ~50 MB de CSV simulado sin que el heap crezca proporcionalmente al tamaño del archivo", async () => {
    const HEADER = "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,importe,moneda,fecha_inicio,fecha_fin\n";
    const rowText = (i: number) =>
      `C${i},E${i},Proveedor de prueba numero ${i},Servicio de prueba numero ${i},${1000 + i},MXN,` +
      "2020-01-01 00:00:00.000000 +00:00,2020-02-01 00:00:00.000000 +00:00\n";

    const TOTAL_BYTES_TARGET = 50 * 1024 * 1024; // 50 MB simulados (mismo volumen medido en la reverificación adversarial 2)
    const LOTE_BYTES = 2 * 1024 * 1024; // "tamaño de un lote" de referencia para el umbral de memoria (2 MiB)

    // Genera el CSV en chunks de ~LOTE_BYTES SIN construir nunca la cadena completa de 50 MB: cada chunk se arma
    // acumulando filas hasta alcanzar el tamaño objetivo, se entrega (`yield`) y se suelta inmediatamente (no
    // queda ninguna referencia al buffer anterior una vez reasignado).
    async function* generateCsvChunks(): AsyncGenerator<string> {
      yield HEADER;
      let producedBytes = 0;
      let rowIndex = 0;
      let buffer = "";
      while (producedBytes < TOTAL_BYTES_TARGET) {
        const row = rowText(rowIndex);
        buffer += row;
        producedBytes += row.length;
        rowIndex += 1;
        if (buffer.length >= LOTE_BYTES) {
          yield buffer;
          buffer = "";
        }
      }
      if (buffer.length > 0) yield buffer;
    }

    // Best-effort: si el proceso corre con `--expose-gc` (p.ej. `NODE_OPTIONS=--expose-gc`), se fuerza una
    // recolección antes de medir para reducir ruido de basura aún no recolectada; si no está disponible, la
    // medición sigue siendo válida (solo más conservadora/generosa, ver docstring del archivo).
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heapBefore = process.memoryUsage().heapUsed;

    let recordCount = 0;
    let errorCount = 0;
    for await (const event of parseComprasMxHistoricoCsvStreamed(generateCsvChunks(), {
      fetchedAt: new Date("2026-09-05T00:00:00Z"),
      publishingEntity: "Entidad de prueba (test de memoria acotada)",
    })) {
      if (event.kind === "record") recordCount += 1;
      else errorCount += 1;
      // Nunca se acumulan los eventos/registros en un arreglo -- solo se cuentan, para no reintroducir
      // artificialmente en el TEST la misma multiplicación de memoria que se está verificando que el PARSER evita.
    }

    gc?.();
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowth = heapAfter - heapBefore;

    expect(errorCount).toBe(0);
    expect(recordCount).toBeGreaterThan(100_000); // confirma que sí se procesó el volumen esperado (~50 MB), no un archivo trivial

    if (gc) {
      // `npm run test`/`test:coverage` de este paquete ya configuran `NODE_OPTIONS=--expose-gc` (ver package.json)
      // precisamente para que esta rama SIEMPRE se ejecute en la corrida real de la suite.
      expect(heapGrowth).toBeLessThan(5 * LOTE_BYTES);
    } else {
      // Sin `--expose-gc` disponible (p.ej. `npx vitest` invocado directamente, fuera del script de package.json),
      // `heapUsed` incluye basura aún no recolectada y no es un umbral confiable -- se documenta la medición
      // igual (visible en el reporte) en vez de fallar la suite por una limitación del entorno de ejecución, no
      // del código bajo prueba.
      console.warn(`[csv-streaming-memory] --expose-gc no disponible: heapGrowth=${heapGrowth} sin medición forzada, umbral estricto omitido.`);
    }
  }, 30_000);
});
