/**
 * Parser CSV RFC 4180 (comillas dobles, comas y saltos de línea dentro de
 * campos entrecomillados, comilla doble escapada como `""`). Implementación
 * propia sin dependencias externas a propósito (evita traer una librería
 * completa para un formato bien definido), probada contra fixtures reales
 * con comillas, comas escapadas, saltos de línea embebidos y filas
 * malformadas (SR-15/16/17).
 *
 * A diferencia de la versión anterior de este parser (que rellenaba con
 * `""` las columnas de MENOS y descartaba en SILENCIO las columnas de MÁS,
 * desalineando el resto de la fila sin ningún aviso -- SR-17), esta versión:
 * - sigue rellenando con `""` las filas con MENOS columnas que el
 *   encabezado (tolerable: un campo faltante al final de una fila real no
 *   implica que el resto esté corrupto), pero
 * - RECHAZA explícitamente (como un error de fila con su número, no como un
 *   registro desalineado en silencio) cualquier fila con MÁS columnas que
 *   el encabezado -- síntoma típico de una coma sin escapar en un campo no
 *   entrecomillado.
 *
 * El llamador (p.ej. `parseComprasMxHistoricoCsv`, SR-16) es responsable de
 * envolver la validación/mapeo de cada fila en su propio `try/catch` y
 * acumular también esos errores por número de fila, para que UNA fila
 * inválida en cualquier punto del archivo nunca haga perder el resto del
 * lote (antes: un archivo de ~951 MB con una sola fila inválida perdía
 * TODAS sus filas válidas).
 */

export interface CsvRowError {
  /** Número de fila de datos, 1-based, contando la primera fila DESPUÉS del encabezado como fila 1. */
  row: number;
  message: string;
}

export interface CsvDataRow {
  /** Número de fila de datos, 1-based (ver `CsvRowError.row`). */
  row: number;
  values: Record<string, string>;
}

export interface CsvParseResult {
  header: string[];
  rows: CsvDataRow[];
  errors: CsvRowError[];
}

export function parseCsv(text: string): CsvParseResult {
  const rawRows = parseCsvRows(text);
  if (rawRows.length === 0) return { header: [], rows: [], errors: [] };
  const [header, ...dataRows] = rawRows;

  const rows: CsvDataRow[] = [];
  const errors: CsvRowError[] = [];

  dataRows.forEach((row, index) => {
    const rowNumber = index + 1;
    const isTrailingBlankLine = row.length === 1 && row[0] === "";
    if (isTrailingBlankLine) return; // línea en blanco final (típica de un archivo que termina en salto de línea): no es un error.

    if (row.length > header.length) {
      errors.push({
        row: rowNumber,
        message:
          `La fila tiene ${row.length} columnas pero el encabezado declara ${header.length}: probablemente una ` +
          "coma sin escapar en un campo no entrecomillado (SR-17). Fila descartada explícitamente, no se arma un registro desalineado.",
      });
      return;
    }

    const values: Record<string, string> = {};
    header.forEach((key, i) => {
      values[key] = row[i] ?? "";
    });
    rows.push({ row: rowNumber, values });
  });

  return { header, rows, errors };
}

/**
 * Parser CSV en STREAMING, línea a línea, con memoria acotada (mejora de
 * memoria, ronda 3 de corrección). `parseCsv()`/`parseCsvRows()` arriba
 * (sin cambios, siguen siendo la API para un texto ya completo en memoria)
 * requieren tener el archivo COMPLETO como una sola cadena antes de
 * devolver la primera fila -- medido en la ronda de reverificación
 * adversarial 2 en **46.38x** de multiplicación de memoria sobre el tamaño
 * del archivo fuente (50 MB simulados -> 2318.8 MB de heap), inviable
 * contra el archivo REAL de ~951 MB (ver README). `CsvRowStreamParser`
 * consume el texto en CHUNKS (ya decodificados, ver
 * `util/encoding.ts#decodeByteChunksStream`) y devuelve cada fila COMPLETA
 * tan pronto como el separador de fila aparece, sin acumular el archivo
 * completo ni el arreglo completo de filas -- la memoria que retiene es
 * proporcional al campo/fila más grande en curso, no al archivo completo.
 *
 * Reimplementa el mismo manejo de comillas dobles/comas/saltos de línea
 * embebidos que `parseCsvRows()` (RFC 4180), pero carácter a carácter y
 * SIN mirar `text[i+1]` directamente (`normalized[i+1]` no existe cuando
 * el carácter siguiente puede llegar en el SIGUIENTE chunk) -- usa en su
 * lugar dos flags de estado que se resuelven en la llamada a `push()`
 * siguiente: `pendingQuote` (para decidir si una `"` dentro de un campo
 * entrecomillado es una comilla escapada `""` o el cierre de la sección) y
 * `pendingCr` (para reconocer `\r\n` aunque el `\r` y el `\n` caigan en
 * chunks distintos, igual que el `replace(/\r\n/g, "\n")` de `parseCsvRows`
 * pero sin poder mirar hacia adelante en una sola cadena).
 */
export class CsvRowStreamParser {
  private row: string[] = [];
  private field = "";
  private inQuotes = false;
  private pendingQuote = false;
  private pendingCr = false;

  /** Alimenta un chunk de texto YA DECODIFICADO y devuelve las filas RAW (arrays de strings) que se completaron con este chunk. */
  push(text: string): string[][] {
    const completed: string[][] = [];
    let start = 0;

    if (this.pendingCr) {
      this.pendingCr = false;
      if (text.length > 0 && text[0] === "\n") {
        this.handleChar("\n", completed);
        start = 1;
      } else {
        this.handleChar("\r", completed); // \r suelto (no seguido de \n): contenido literal, igual que parseCsvRows.
      }
    }

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (char === "\r") {
        if (i === text.length - 1) {
          this.pendingCr = true; // podría ser un \r\n partido justo en la frontera del siguiente chunk.
          continue;
        }
        if (text[i + 1] === "\n") {
          this.handleChar("\n", completed);
          i += 1;
          continue;
        }
        this.handleChar("\r", completed);
        continue;
      }
      this.handleChar(char, completed);
    }
    return completed;
  }

  /** Cierra el parser al terminar el stream: devuelve la última fila pendiente (si el archivo no termina en salto de línea), igual que `parseCsvRows`. */
  finish(): string[][] {
    const completed: string[][] = [];
    if (this.pendingCr) {
      this.handleChar("\r", completed);
      this.pendingCr = false;
    }
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.field.length > 0 || this.row.length > 0) {
      this.row.push(this.field);
      completed.push(this.row);
      this.row = [];
      this.field = "";
    }
    return completed;
  }

  private handleChar(char: string, completed: string[][]): void {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (char === '"') {
        this.field += '"';
        return;
      }
      this.inQuotes = false;
      // Sin `return`: el cierre de comillas consume SOLO la comilla anterior; este `char` (el que sigue a la
      // comilla de cierre) se procesa fresco bajo las reglas de "fuera de comillas" más abajo.
    }

    if (this.inQuotes) {
      if (char === '"') {
        this.pendingQuote = true;
      } else {
        this.field += char;
      }
      return;
    }

    if (char === '"') {
      this.inQuotes = true;
    } else if (char === ",") {
      this.row.push(this.field);
      this.field = "";
    } else if (char === "\n") {
      this.row.push(this.field);
      completed.push(this.row);
      this.row = [];
      this.field = "";
    } else {
      this.field += char;
    }
  }
}

/**
 * Evento producido por `streamCsvRows()` por cada fila de DATOS (excluye el
 * encabezado, que se consume internamente): una fila válida (`row`) o un
 * error de forma (`error`, mismo criterio que `parseCsv`: MÁS columnas que
 * el encabezado -- SR-17). Nunca se pierde una fila en silencio.
 */
export type CsvStreamRowEvent = { kind: "row"; data: CsvDataRow } | { kind: "error"; error: CsvRowError };

/**
 * Variante en streaming de `parseCsv()`: consume un `AsyncIterable<string>`
 * de chunks YA DECODIFICADOS (ver `decodeByteChunksStream`) y produce cada
 * fila de datos tan pronto como está completa, con la MISMA semántica que
 * `parseCsv` (encabezado = primera fila; columnas de MENOS se rellenan con
 * `""`; columnas de MÁS -> `error` explícito, SR-17; línea en blanco final
 * se ignora) -- sin acumular nunca el archivo completo ni el arreglo
 * completo de filas en memoria.
 */
export async function* streamCsvRows(chunks: AsyncIterable<string>): AsyncGenerator<CsvStreamRowEvent> {
  const parser = new CsvRowStreamParser();
  let header: string[] | undefined;
  let rowNumber = 0;

  function* handleRawRow(rawRow: string[]): Generator<CsvStreamRowEvent> {
    if (!header) {
      header = rawRow;
      return;
    }
    rowNumber += 1;
    const isTrailingBlankLine = rawRow.length === 1 && rawRow[0] === "";
    if (isTrailingBlankLine) return;

    if (rawRow.length > header.length) {
      yield {
        kind: "error",
        error: {
          row: rowNumber,
          message:
            `La fila tiene ${rawRow.length} columnas pero el encabezado declara ${header.length}: probablemente una ` +
            "coma sin escapar en un campo no entrecomillado (SR-17). Fila descartada explícitamente, no se arma un registro desalineado.",
        },
      };
      return;
    }

    const values: Record<string, string> = {};
    header.forEach((key, i) => {
      values[key] = rawRow[i] ?? "";
    });
    yield { kind: "row", data: { row: rowNumber, values } };
  }

  for await (const chunkText of chunks) {
    for (const rawRow of parser.push(chunkText)) {
      yield* handleRawRow(rawRow);
    }
  }
  for (const rawRow of parser.finish()) {
    yield* handleRawRow(rawRow);
  }
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, "\n");

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
