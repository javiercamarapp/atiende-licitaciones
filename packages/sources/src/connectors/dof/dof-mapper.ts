import { hashRawPayload } from "../../util/hash.js";
import { fromMexicoCityNaive } from "../../util/timezone.js";
import { parseTenderRecord, type TenderRecord } from "../../types/tender-record.js";
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
export function extractDofNoticesFromText(text: string, codigo: string, fecha: string): DofNotice[] {
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
  for (const block of blocks) {
    const dependenciaMatch = block.match(/^([^.\n]+?)\.-/);
    const numeroMatch = block.match(/convocatoria\s*(?:n[uú]mero|no\.?|n[uú]m\.?)?\s*[:-]?\s*([A-Za-z0-9/-]+)/i);
    const tituloMatch = block.match(/objeto(?: de la (?:licitaci[oó]n|contrataci[oó]n))?\s*[:-]\s*([^\n]+)/i);
    const juntaMatch = block.match(/junta de aclaraciones\s*[:-]?\s*([^\n,;]+)/i);
    const aperturaMatch = block.match(/(?:presentaci[oó]n y apertura de proposiciones|acto de presentaci[oó]n)\s*[:-]?\s*([^\n,;]+)/i);
    const falloMatch = block.match(/fallo\s*[:-]?\s*([^\n,;]+)/i);

    if (!dependenciaMatch) continue;

    const cleanCapture = (value: string | undefined) => value?.trim().replace(/[.,;]+$/, "");

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
  }
  return notices;
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
