import { hashRawPayload } from "../../util/hash.js";
import { fromMexicoCityNaive } from "../../util/timezone.js";
import { parseTenderRecord, type TenderRecord } from "../../types/tender-record.js";
import type { DroppedRecordInfo } from "../types.js";
import { DofNoticeSchema, type DofNotice } from "./dof-types.js";

/** Convierte una fecha en formato DOF "DD/MM/YYYY" o "DD de mes de YYYY" a Date, o undefined si no se reconoce. */
const MONTHS: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

export function parseDofDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/[.,;]+$/, "");
  const slashMatch = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashMatch) {
    const [, d, m, y] = slashMatch;
    return fromMexicoCityNaive(`${y}-${m}-${d}`);
  }
  const longMatch = cleaned.toLowerCase().match(/^(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})$/);
  if (longMatch) {
    const [, d, monthName, y] = longMatch;
    const month = MONTHS[monthName];
    if (month) return fromMexicoCityNaive(`${y}-${month}-${d.padStart(2, "0")}`);
  }
  return undefined;
}

/**
 * Extrae bloques de "aviso de convocatoria" de texto plano (ya sin
 * etiquetas HTML) de una nota del DOF, usando heurísticas sobre las
 * etiquetas de campo que las convocatorias tipo (bases SFP/normatividad de
 * adquisiciones) usan consistentemente: "Convocatoria...", "Junta de
 * aclaraciones", "Presentación y apertura de proposiciones", "Fallo".
 * PENDIENTE VERIFICACIÓN REAL (ver README §DOF): no se confirmó en vivo
 * dentro de la ventana de prueba una nota real con este formato exacto;
 * el parser corre sobre un fixture reconstruido a partir del formato
 * públicamente conocido de "Sección de Avisos" del DOF.
 */
/**
 * SR-24 (residual de SR-21, mismo mecanismo generalizado a DOF): resultado
 * de `extractDofNoticesFromText` -- ademas de los avisos válidos, reporta en
 * `dropped[]` cualquier bloque de texto que parecía el inicio de un aviso
 * (matcheó el patrón "DEPENDENCIA.-Convocatoria") pero no se pudo convertir
 * en un `DofNotice` válido, en vez de descartarlo en silencio (`continue`
 * sin rastro, como hacía esta función antes de esta ronda).
 */
export interface DofExtractResult {
  notices: DofNotice[];
  dropped: DroppedRecordInfo[];
}

export function extractDofNoticesFromText(text: string, codigo: string, fecha: string): DofExtractResult {
  // Un bloque nuevo empieza donde el DOF marca "DEPENDENCIA.-Convocatoria..." (formato consistente en avisos de
  // licitación). Se corta el texto en esos puntos en vez de por líneas en blanco, porque tras quitar las etiquetas
  // HTML un mismo aviso queda repartido en varios "párrafos" separados por saltos de línea.
  const startMarker = /\n?([A-ZÁÉÍÓÚÑ][^.\n]{2,80})\.-\s*Convocatoria/g;
  const starts: number[] = [];
  for (const match of text.matchAll(startMarker)) {
    starts.push(match.index ?? 0);
  }

  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    blocks.push(text.slice(starts[i], end).trim());
  }

  const notices: DofNotice[] = [];
  const dropped: DroppedRecordInfo[] = [];

  blocks.forEach((block, index) => {
    const dependenciaMatch = block.match(/^([^.\n]+?)\.-/);
    const numeroMatch = block.match(/convocatoria\s*(?:n[uú]mero|no\.?|n[uú]m\.?)?\s*[:-]?\s*([A-Za-z0-9/-]+)/i);
    const tituloMatch = block.match(/objeto(?: de la (?:licitaci[oó]n|contrataci[oó]n))?\s*[:-]\s*([^\n]+)/i);
    const juntaMatch = block.match(/junta de aclaraciones\s*[:-]?\s*([^\n,;]+)/i);
    const aperturaMatch = block.match(/(?:presentaci[oó]n y apertura de proposiciones|acto de presentaci[oó]n)\s*[:-]?\s*([^\n,;]+)/i);
    const falloMatch = block.match(/fallo\s*[:-]?\s*([^\n,;]+)/i);

    // SR-24: antes de esta ronda, un bloque sin `dependenciaMatch` (defensivo: la propia forma en que `blocks`
    // se genera hace este caso inalcanzable hoy, pero no debe volver a desaparecer en silencio si el patrón de
    // corte cambia) se saltaba con `continue`, sin ningún rastro en `errors[]`/`dropped[]`.
    if (!dependenciaMatch) {
      dropped.push({
        index,
        reason: "Bloque de aviso sin dependencia identificable al inicio (patrón 'DEPENDENCIA.-Convocatoria' no coincide)",
        fields: { snippet: block.slice(0, 120) },
      });
      return;
    }

    const cleanCapture = (value: string | undefined) => value?.trim().replace(/[.,;]+$/, "");

    try {
      notices.push(
        DofNoticeSchema.parse({
          codigo,
          fecha,
          dependencia: dependenciaMatch[1].trim(),
          numeroConvocatoria: cleanCapture(numeroMatch?.[1]),
          titulo: (tituloMatch?.[1] ?? block.slice(0, 120)).trim(),
          fechaJuntaAclaraciones: cleanCapture(juntaMatch?.[1]),
          fechaPresentacionApertura: cleanCapture(aperturaMatch?.[1]),
          fechaFallo: cleanCapture(falloMatch?.[1]),
        }),
      );
    } catch (error) {
      // Defensivo (SR-24, mismo patrón que `mapComprasMxApiRecords`): no debería ocurrir dado que los campos
      // requeridos de `DofNoticeSchema` ya se validaron arriba, pero se reporta igual en vez de abortar
      // TODOS los avisos de la nota (incluidos los válidos antes/después de este bloque) si el esquema cambiara.
      dropped.push({
        index,
        reason: `Bloque no cumple el esquema de aviso esperado: ${error instanceof Error ? error.message : String(error)}`,
        fields: { snippet: block.slice(0, 120) },
      });
    }
  });

  return { notices, dropped };
}

export interface DofMapOptions {
  sourceUrl: string;
  fetchedAt: Date;
  httpStatus?: number;
}

export function mapDofNoticeToTenderRecord(notice: DofNotice, rawText: string, options: DofMapOptions): TenderRecord {
  const externalId = `${notice.codigo}:${notice.numeroConvocatoria ?? notice.titulo.slice(0, 40)}`;
  const raw: unknown = {
    source: "dof",
    externalId,
    title: notice.titulo,
    contractingEntity: notice.dependencia,
    procedureType: "licitacion_publica",
    procedureTypeRaw: "Convocatoria publicada en DOF (Sección de Avisos)",
    classifiers: [],
    currency: "MXN",
    dates: {
      published: parseDofDate(notice.fecha),
      clarificationMeeting: parseDofDate(notice.fechaJuntaAclaraciones),
      submissionDeadline: parseDofDate(notice.fechaPresentacionApertura),
      award: parseDofDate(notice.fechaFallo),
    },
    status: "published",
    statusRaw: "publicado-dof",
    url: options.sourceUrl,
    attachments: [],
    snapshot: {
      sourceUrl: options.sourceUrl,
      fetchedAt: options.fetchedAt,
      rawHash: hashRawPayload(rawText),
      httpStatus: options.httpStatus,
    },
  };
  return parseTenderRecord(raw);
}

/**
 * SR-24 (residual de SR-21, generalizado a DOF): variante de
 * `mapDofNoticeToTenderRecord` que NUNCA lanza -- antes de esta ronda,
 * `createDofConnector.discover()` invocaba `mapDofNoticeToTenderRecord`
 * directamente dentro del `for` de avisos sin ningún `try/catch`: un solo
 * aviso que no cumpliera `TenderRecordSchema` (p.ej. por una configuración
 * de `baseUrl` que produce un `sourceUrl` inválido) abortaba el generador
 * completo, perdiendo TODOS los avisos restantes de la nota actual Y de
 * cualquier `noteCodes` posterior en la misma corrida (el mismo antipatrón
 * que SR-16 corrigió para el CSV histórico de ComprasMX). Devuelve el
 * `TenderRecord` si el mapeo tuvo éxito, o la `DroppedRecordInfo` lista para
 * reenviar a `ctx.reportDropped()` si no.
 */
export function mapDofNoticeToTenderRecordSafe(
  notice: DofNotice,
  rawText: string,
  options: DofMapOptions,
): { record: TenderRecord } | { dropped: DroppedRecordInfo } {
  try {
    return { record: mapDofNoticeToTenderRecord(notice, rawText, options) };
  } catch (error) {
    return {
      dropped: {
        externalId: `${notice.codigo}:${notice.numeroConvocatoria ?? notice.titulo.slice(0, 40)}`,
        reason: `Aviso descartado: no se pudo mapear a TenderRecord (${error instanceof Error ? error.message : String(error)})`,
        fields: { codigo: notice.codigo, numeroConvocatoria: notice.numeroConvocatoria, titulo: notice.titulo },
      },
    };
  }
}
