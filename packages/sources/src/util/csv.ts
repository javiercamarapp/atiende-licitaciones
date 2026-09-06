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
