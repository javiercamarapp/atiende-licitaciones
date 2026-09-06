import { hashRawPayload } from "../../util/hash.js";
import { parseCsv, type CsvRowError } from "../../util/csv.js";
import { fromMexicoCityNaive } from "../../util/timezone.js";
import { parseTenderRecord, type TenderRecord } from "../../types/tender-record.js";
import type { DroppedRecordInfo } from "../types.js";
import { ComprasMxApiRecordSchema, ComprasMxHistoricoCsvRowSchema, type ComprasMxApiRecord } from "./comprasmx-types.js";

/**
 * Convierte una fecha del API/CSV de ComprasMX a `Date` pasando SIEMPRE por
 * `fromMexicoCityNaive()` (SR-02): el esquema de `comprasmx-types.ts` está
 * marcado "INFERIDO... no confirmado contra un payload real", así que no se
 * puede asumir que el backend real emita offset explícito. Sin este guard,
 * `TenderDatesSchema` (`z.coerce.date()` -> `new Date(string)`) interpretaría
 * una fecha/hora naive según el TZ del PROCESO que ejecuta el conector
 * (p.ej. UTC en un contenedor de producción), produciendo un instante hasta
 * 6 horas distinto del real. `fromMexicoCityNaive` respeta un offset
 * explícito si ya viene en la cadena (p.ej. "...Z"), y solo aplica la
 * interpretación de hora del Centro de México cuando la cadena es naive.
 */
function parseComprasMxDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  return fromMexicoCityNaive(raw);
}

const TIPO_CONTRATACION_TO_PROCEDURE: Record<string, TenderRecord["procedureType"]> = {
  "licitacion publica": "licitacion_publica",
  "licitación pública": "licitacion_publica",
  "invitacion restringida": "invitacion_restringida",
  "invitación a cuando menos tres personas": "invitacion_restringida",
  "adjudicacion directa": "adjudicacion_directa",
  "adjudicación directa": "adjudicacion_directa",
};

function mapProcedureType(raw: string | undefined): TenderRecord["procedureType"] {
  if (!raw) return "otro";
  const key = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  for (const [needle, value] of Object.entries(TIPO_CONTRATACION_TO_PROCEDURE)) {
    const normalizedNeedle = needle.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (key.includes(normalizedNeedle)) return value;
  }
  return "otro";
}

export interface ComprasMxMapOptions {
  sourceUrl?: string;
  fetchedAt: Date;
  httpStatus?: number;
}

/**
 * Mapea un registro del endpoint público "expedientes" (esquema inferido,
 * ver `comprasmx-types.ts`) a `TenderRecord`. Se usa contra fixtures porque
 * el endpoint real exige reCAPTCHA (REQ-079: nunca se intenta eludir).
 */
export function mapComprasMxApiRecordToTenderRecord(rawRecord: unknown, options: ComprasMxMapOptions): TenderRecord | null {
  const record = ComprasMxApiRecordSchema.parse(rawRecord);
  const externalId = record.codigo_expediente ?? record.cod_expediente ?? (record.id_proceso ? String(record.id_proceso) : undefined);
  if (!externalId || !record.titulo_expediente) return null;

  const raw: unknown = {
    source: "compras-mx",
    externalId,
    title: record.titulo_expediente,
    contractingEntity: record.dependencia_entidad ?? record.unidad_compradora ?? "desconocido",
    procuringUnit: record.unidad_compradora,
    procedureType: mapProcedureType(record.tipo_contratacion),
    procedureTypeRaw: record.tipo_contratacion ?? record.tipo_expediente,
    classifiers: [],
    budgetAmount: record.monto_estimado,
    currency: record.moneda ?? "MXN",
    dates: {
      published: parseComprasMxDate(record.fecha_publicacion),
      clarificationMeeting: parseComprasMxDate(record.fecha_junta_aclaraciones),
      submissionDeadline: parseComprasMxDate(record.fecha_apertura_proposiciones),
      award: parseComprasMxDate(record.fecha_fallo),
    },
    status: mapStatus(record.estatus),
    statusRaw: record.estatus,
    state: record.entidad_federativa_contratacion,
    attachments: [],
    snapshot: {
      sourceUrl: options.sourceUrl,
      fetchedAt: options.fetchedAt,
      rawHash: hashRawPayload(rawRecord),
      httpStatus: options.httpStatus,
    },
  };
  return parseTenderRecord(raw);
}

function mapStatus(raw: string | undefined): TenderRecord["status"] {
  if (!raw) return "unknown";
  const key = raw.toLowerCase();
  if (key.includes("public")) return "published";
  if (key.includes("aclaracion")) return "clarification";
  if (key.includes("vigente") || key.includes("abiert")) return "open_for_submission";
  if (key.includes("cerrad")) return "closed_for_submission";
  if (key.includes("fallo") || key.includes("adjudic")) return "awarded";
  if (key.includes("cancel")) return "cancelled";
  if (key.includes("desiert")) return "void";
  return "unknown";
}

/**
 * SR-21 (ronda 3 de corrección): un registro que `mapComprasMxApiRecordToTenderRecord`
 * descarta (esquema inválido, o `codigo_expediente`/`titulo_expediente` ausentes) ya NO
 * desaparece en silencio -- se acumula aquí con su índice (0-based dentro del lote),
 * `externalId` (si se pudo determinar) y el motivo exacto. `createComprasMxConnector`
 * reenvía cada entrada a `ctx.reportDropped()` para que `DiscoveryPipeline` la registre en
 * `errores`/`dropped` y aplique el umbral de tasa de descarte (`dropRateThreshold`).
 */
export interface ComprasMxApiRecordsMapResult {
  records: TenderRecord[];
  dropped: DroppedRecordInfo[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapComprasMxApiRecords(rawRecords: unknown[], options: ComprasMxMapOptions): ComprasMxApiRecordsMapResult {
  const records: TenderRecord[] = [];
  const dropped: DroppedRecordInfo[] = [];

  rawRecords.forEach((raw, index) => {
    let parsed: ComprasMxApiRecord;
    try {
      parsed = ComprasMxApiRecordSchema.parse(raw);
    } catch (error) {
      dropped.push({
        index,
        reason: `Registro no cumple el esquema esperado: ${error instanceof Error ? error.message : String(error)}`,
        fields: isPlainObject(raw) ? raw : undefined,
      });
      return;
    }

    const externalId = parsed.codigo_expediente ?? parsed.cod_expediente ?? (parsed.id_proceso ? String(parsed.id_proceso) : undefined);
    if (!externalId || !parsed.titulo_expediente) {
      dropped.push({
        index,
        externalId,
        reason: !externalId
          ? "Registro sin identificador (codigo_expediente/cod_expediente/id_proceso ausentes o null)"
          : "Registro sin título (titulo_expediente ausente/null): campo requerido en TenderRecord.title (SR-13/SR-21)",
        fields: {
          codigo_expediente: parsed.codigo_expediente,
          cod_expediente: parsed.cod_expediente,
          id_proceso: parsed.id_proceso,
          titulo_expediente: parsed.titulo_expediente,
        },
      });
      return;
    }

    const mapped = mapComprasMxApiRecordToTenderRecord(raw, options);
    if (!mapped) {
      // Defensivo: no debería ocurrir dado que ya se validaron las mismas condiciones arriba, pero se reporta
      // igual en vez de descartar en silencio si `mapComprasMxApiRecordToTenderRecord` cambiara su criterio.
      dropped.push({ index, externalId, reason: "Registro descartado por mapComprasMxApiRecordToTenderRecord (motivo no determinado por el llamador)" });
      return;
    }
    records.push(mapped);
  });

  return { records, dropped };
}

export interface ComprasMxHistoricoCsvParseResult {
  records: TenderRecord[];
  /** Filas descartadas (por número de fila, 1-based tras el encabezado) con el motivo — SR-16/17: nunca vacían el resto del lote. */
  errors: CsvRowError[];
}

/**
 * Parsea el CSV histórico REAL de contratos/expedientes de CompraNet
 * (verificado en vivo el 2026-09-05, ver README §ComprasMX). Es un dataset
 * de CONTRATOS YA CONCLUIDOS (2010-2022), no de convocatorias abiertas, y
 * no incluye columna de dependencia/entidad convocante — por eso
 * `contractingEntity` usa el nombre documentado de la entidad publicadora
 * del dataset como mejor aproximación disponible (limitación conocida,
 * documentada en README).
 *
 * `fecha_inicio`/`fecha_fin` (con `ff_fecha_inicio`/`ff_fecha_fin` como
 * respaldo) pasan por `parseComprasMxDate()` -> `fromMexicoCityNaive()`
 * (SR-12): este conector fue agregado DESPUÉS del fix de SR-02 y mapeaba
 * esas fechas DIRECTO a `TenderDatesSchema` (`z.coerce.date()` -> `new
 * Date(string)`), reintroduciendo la misma dependencia del TZ del proceso
 * para una fila naive (sin offset) que SR-02 cerró para el API en vivo. El
 * dataset real verificado siempre trae offset explícito, así que
 * `fromMexicoCityNaive` es hoy un no-op idéntico en la práctica, pero deja
 * de serlo en silencio si el formato del export cambia.
 *
 * Cada fila se valida/mapea en su PROPIO `try/catch` (SR-16): antes de este
 * fix, una sola fila inválida en cualquier punto del archivo (p.ej.
 * `importe` no numérico) hacía que la función completa lanzara, perdiendo
 * TODAS las filas válidas del lote (esta función no hace streaming: arma el
 * array completo de `TenderRecord` antes de que el conector empiece a
 * producir el primero). Las filas inválidas — incluidas las que `parseCsv`
 * ya descartó explícitamente por tener MÁS columnas que el encabezado,
 * SR-17 — se acumulan en `errors[]` con su número de fila, sin abortar el
 * resto del lote.
 */
export function parseComprasMxHistoricoCsv(
  csvText: string,
  options: ComprasMxMapOptions & { publishingEntity: string },
): ComprasMxHistoricoCsvParseResult {
  const { rows, errors: csvErrors } = parseCsv(csvText);
  const records: TenderRecord[] = [];
  const errors: CsvRowError[] = [...csvErrors];

  for (const { row: rowNumber, values: rawRow } of rows) {
    try {
      const row = ComprasMxHistoricoCsvRowSchema.parse(rawRow);
      const raw: unknown = {
        source: "compras-mx",
        externalId: row.codigo_expediente || row.codigo_contrato,
        title: row.titulo_contrato,
        contractingEntity: options.publishingEntity,
        procedureType: mapProcedureType(row.tipo_contratacion ?? row.tipo_expediente),
        procedureTypeRaw: row.tipo_expediente ?? row.tipo_contratacion,
        classifiers: [],
        budgetAmount: row.importe ? Number.parseFloat(row.importe) : undefined,
        currency: row.moneda ?? "MXN",
        dates: {
          published: parseComprasMxDate(row.fecha_inicio ?? row.ff_fecha_inicio),
          award: parseComprasMxDate(row.fecha_fin ?? row.ff_fecha_fin ?? row.fecha_inicio ?? row.ff_fecha_inicio),
        },
        status: "awarded",
        statusRaw: "historico-compranet",
        attachments: [],
        snapshot: {
          sourceUrl: options.sourceUrl,
          fetchedAt: options.fetchedAt,
          rawHash: hashRawPayload(rawRow),
          httpStatus: options.httpStatus,
        },
      };
      records.push(parseTenderRecord(raw));
    } catch (error) {
      errors.push({ row: rowNumber, message: error instanceof Error ? error.message : String(error) });
    }
  }

  errors.sort((a, b) => a.row - b.row);
  return { records, errors };
}

export type { ComprasMxApiRecord };
