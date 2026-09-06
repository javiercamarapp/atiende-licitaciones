import { hashRawPayload } from "../../util/hash.js";
import { parseCsv } from "../../util/csv.js";
import { parseTenderRecord, type TenderRecord } from "../../types/tender-record.js";
import { ComprasMxApiRecordSchema, ComprasMxHistoricoCsvRowSchema, type ComprasMxApiRecord } from "./comprasmx-types.js";

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
      published: record.fecha_publicacion,
      clarificationMeeting: record.fecha_junta_aclaraciones,
      submissionDeadline: record.fecha_apertura_proposiciones,
      award: record.fecha_fallo,
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

/** Función usada por `createOcdsConnector`-style consumers necesita array plano; helper de paginación simple para el fixture del API inferido. */
export function mapComprasMxApiRecords(rawRecords: unknown[], options: ComprasMxMapOptions): TenderRecord[] {
  const out: TenderRecord[] = [];
  for (const raw of rawRecords) {
    const mapped = mapComprasMxApiRecordToTenderRecord(raw, options);
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * Parsea el CSV histórico REAL de contratos/expedientes de CompraNet
 * (verificado en vivo el 2026-09-05, ver README §ComprasMX). Es un dataset
 * de CONTRATOS YA CONCLUIDOS (2010-2022), no de convocatorias abiertas, y
 * no incluye columna de dependencia/entidad convocante — por eso
 * `contractingEntity` usa el nombre documentado de la entidad publicadora
 * del dataset como mejor aproximación disponible (limitación conocida,
 * documentada en README).
 */
export function parseComprasMxHistoricoCsv(csvText: string, options: ComprasMxMapOptions & { publishingEntity: string }): TenderRecord[] {
  const rows = parseCsv(csvText);
  const records: TenderRecord[] = [];
  for (const rawRow of rows) {
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
        published: row.fecha_inicio,
        award: row.fecha_inicio,
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
  }
  return records;
}

export type { ComprasMxApiRecord };
