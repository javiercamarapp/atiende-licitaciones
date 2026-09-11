/**
 * Parser del CSV público de la lista 69-B del SAT (Art. 69-B del Código
 * Fiscal de la Federación). Formato REAL confirmado en vivo el 2026-09-10
 * contra `http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv`
 * (HTTP 200, sin autenticación, `Content-Type: application/octet-stream`,
 * ~4.5 MB, ~14,200 filas de datos) — ver README.md de este paquete y
 * `test/fixtures/sat-69b/listado-real-sample.csv` (muestra real de 30 filas
 * descargada en vivo, en su encoding original, usada por las pruebas).
 *
 * Estructura real del archivo (NO un CSV "limpio" desde la primera línea):
 * 1. Una fila-leyenda con la leyenda legal completa entrecomillada,
 *    incluyendo la fecha de corte ("Información actualizada al 31 de
 *    diciembre de 2025; ..."). Se conserva TAL CUAL en `listAsOfRaw`.
 * 2. Una fila-título ("Listado completo de contribuyentes (Artículo 69-B
 *    del CFF)").
 * 3. El encabezado real de columnas ("No,RFC,Nombre del Contribuyente,
 *    Situación del contribuyente,...").
 * 4. ~14,200 filas de datos.
 *
 * Este parser NUNCA asume que el preámbulo mide exactamente 2 líneas: busca
 * la fila de encabezado real por su CONTENIDO (columnas `RFC` +
 * `Situación`), y todo lo anterior a esa fila se trata como preámbulo del
 * que solo se usa la primera línea para la leyenda de fecha. Si el
 * encabezado real no aparece en absoluto, se reporta como error explícito
 * (nunca se intenta adivinar una fila de datos como si fuera encabezado).
 */
import { parseCsv, stripAccents, type CsvRowError } from "@atiende/sources";
import type { NegativeListEntry } from "../types.js";

export interface ParsedSat69BCsv {
  /** Fecha de corte publicada por el propio SAT en la leyenda, en ISO `YYYY-MM-DD`, o `null` si no se pudo parsear. */
  listAsOfDate: string | null;
  /** Texto crudo completo de la línea de leyenda (primera línea del archivo), o `null` si el archivo viene vacío. */
  listAsOfRaw: string | null;
  /** Motivo por el que `listAsOfDate` quedó en `null` a pesar de haber una leyenda -- solo presente en ese caso. */
  listAsOfParseError?: string;
  entries: NegativeListEntry[];
  errors: CsvRowError[];
}

const MONTHS_ES: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

/**
 * Extrae "al D de <mes> de YYYY" de la leyenda cruda del SAT. Devuelve
 * `null` (con el motivo aparte) si el patrón no aparece -- nunca se cae de
 * vuelta a `fetchedAt` ni a ninguna otra fecha: son dos fechas con
 * significado distinto (cuándo el SAT dice haber actualizado el listado vs.
 * cuándo este sistema lo bajó), confundirlas sería fabricar un dato.
 */
export function parseListAsOfLegend(legendRaw: string): { date: string | null; error?: string } {
  const match = /al\s+(\d{1,2})\s+de\s+([a-zA-Z]+)\s+de\s+(\d{4})/u.exec(legendRaw);
  if (!match) {
    return { date: null, error: 'No se encontró el patrón "al D de <mes> de YYYY" en la leyenda del CSV.' };
  }
  const [, dayRaw, monthRaw, yearRaw] = match;
  const monthKey = stripAccents(monthRaw).toLowerCase();
  const month = MONTHS_ES[monthKey];
  if (!month) {
    return { date: null, error: `Mes "${monthRaw}" no reconocido en la leyenda del CSV.` };
  }
  const day = dayRaw.padStart(2, "0");
  return { date: `${yearRaw}-${month}-${day}` };
}

function normalizeHeaderCell(cell: string): string {
  return stripAccents(cell).toLowerCase().trim();
}

/** Localiza el índice de la fila de encabezado REAL por contenido (no por posición fija). */
function findHeaderLineIndex(lines: string[]): number {
  return lines.findIndex((line) => {
    const cells = line.split(",").map(normalizeHeaderCell);
    return cells.includes("rfc") && cells.some((c) => c.startsWith("situacion"));
  });
}

export function parseSat69BCsvText(rawText: string): ParsedSat69BCsv {
  const lines = rawText.split(/\r\n|\r|\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === "")) {
    return { listAsOfDate: null, listAsOfRaw: null, entries: [], errors: [] };
  }

  const listAsOfRaw = lines[0] ?? null;
  const legend = listAsOfRaw ? parseListAsOfLegend(listAsOfRaw) : { date: null, error: "Archivo vacío." };

  const headerIdx = findHeaderLineIndex(lines);
  if (headerIdx === -1) {
    return {
      listAsOfDate: legend.date,
      listAsOfRaw,
      listAsOfParseError: legend.error,
      entries: [],
      errors: [{ row: 0, message: 'No se encontró la fila de encabezado real (columnas "RFC"/"Situación...") en el CSV.' }],
    };
  }

  const dataText = lines.slice(headerIdx).join("\n");
  const { header, rows, errors } = parseCsv(dataText);

  const normalizedHeader = header.map(normalizeHeaderCell);
  const rfcIdx = normalizedHeader.indexOf("rfc");
  const nameIdx = normalizedHeader.findIndex((c) => c.startsWith("nombre del contribuyente"));
  const situacionIdx = normalizedHeader.findIndex((c) => c.startsWith("situacion"));

  const entries: NegativeListEntry[] = [];
  const rowErrors: CsvRowError[] = [...errors];

  if (rfcIdx === -1 || nameIdx === -1 || situacionIdx === -1) {
    rowErrors.push({
      row: headerIdx,
      message: `Encabezado real localizado pero le faltan columnas esperadas (rfc=${rfcIdx}, nombre=${nameIdx}, situacion=${situacionIdx}).`,
    });
    return { listAsOfDate: legend.date, listAsOfRaw, listAsOfParseError: legend.error, entries, errors: rowErrors };
  }

  for (const row of rows) {
    try {
      const rfc = row.values[header[rfcIdx]]?.trim();
      const nombreContribuyente = row.values[header[nameIdx]]?.trim();
      const situacion = row.values[header[situacionIdx]]?.trim();
      if (!rfc) {
        rowErrors.push({ row: row.row, message: "Fila sin RFC: descartada." });
        continue;
      }
      if (!situacion) {
        rowErrors.push({ row: row.row, message: `Fila con RFC "${rfc}" sin "Situación del contribuyente": descartada.` });
        continue;
      }
      entries.push({ rfc: rfc.toUpperCase(), nombreContribuyente: nombreContribuyente ?? "", situacion });
    } catch (err) {
      rowErrors.push({ row: row.row, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { listAsOfDate: legend.date, listAsOfRaw, listAsOfParseError: legend.error, entries, errors: rowErrors };
}
