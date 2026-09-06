import { hashRawPayload } from "../../util/hash.js";
import type { ClassifierScheme, ProcedureType, SourceId, TenderRecord, TenderStatus } from "../../types/tender-record.js";
import { parseTenderRecord } from "../../types/tender-record.js";
import { OcdsReleasePackageSchema, type OcdsRelease } from "./ocds-types.js";

const PROCUREMENT_METHOD_TO_PROCEDURE_TYPE: Record<string, ProcedureType> = {
  open: "licitacion_publica",
  selective: "invitacion_restringida",
  limited: "adjudicacion_directa",
  direct: "adjudicacion_directa",
};

const OCDS_STATUS_TO_TENDER_STATUS: Record<string, TenderStatus> = {
  planned: "scheduled",
  planning: "scheduled",
  active: "open_for_submission",
  cancelled: "cancelled",
  unsuccessful: "void",
  complete: "awarded",
  withdrawn: "cancelled",
};

const CLASSIFIER_SCHEME_ALIASES: Record<string, ClassifierScheme> = {
  cpv: "CPV",
  unspsc: "UNSPSC",
  cucop: "CUCoP",
  "cucop+": "CUCoP",
};

function mapClassifierScheme(raw: string | undefined): ClassifierScheme {
  if (!raw) return "other";
  return CLASSIFIER_SCHEME_ALIASES[raw.toLowerCase()] ?? "other";
}

function findBuyerName(release: OcdsRelease): string {
  if (release.buyer?.name) return release.buyer.name;
  const buyerParty = release.parties?.find((p) => p.roles?.includes("buyer") || p.roles?.includes("procuringEntity"));
  return buyerParty?.name ?? "desconocido";
}

function findBuyerRegion(release: OcdsRelease): string | undefined {
  const buyerParty = release.parties?.find((p) => p.roles?.includes("buyer") || p.roles?.includes("procuringEntity"));
  return buyerParty?.address?.region;
}

export interface OcdsMapOptions {
  source: SourceId;
  sourceUrl?: string;
  fetchedAt: Date;
  httpStatus?: number;
  /** Estado (entidad federativa) por defecto cuando la fuente no lo distingue por release (p.ej. un portal estatal único). */
  defaultState?: string;
}

/**
 * Mapea un único `release` OCDS 1.1 (tag incluye "tender") a `TenderRecord`.
 * Devuelve `null` si el release no corresponde a una convocatoria (p.ej.
 * releases de solo adjudicación/contrato sin bloque `tender`).
 */
export function mapOcdsReleaseToTenderRecord(release: OcdsRelease, rawPackage: unknown, options: OcdsMapOptions): TenderRecord | null {
  if (!release.tender) return null;

  const classifiers = (release.tender.items ?? [])
    .map((item) => item.classification)
    .filter((c): c is NonNullable<typeof c> => Boolean(c?.id))
    .map((c) => ({
      scheme: mapClassifierScheme(c.scheme),
      code: c.id as string,
      description: c.description,
    }));

  const attachments = (release.tender.documents ?? [])
    .filter((doc) => doc.url || doc.title)
    .map((doc) => ({
      name: doc.title ?? doc.id ?? "documento",
      url: doc.url,
      mimeType: doc.format,
    }));

  const awardDate = release.awards?.find((a) => a.date)?.date;

  const raw = {
    source: options.source,
    externalId: release.tender.id ?? release.ocid,
    title: release.tender.title ?? release.id,
    contractingEntity: findBuyerName(release),
    procedureType: release.tender.procurementMethod ? PROCUREMENT_METHOD_TO_PROCEDURE_TYPE[release.tender.procurementMethod] ?? "otro" : "otro",
    procedureTypeRaw: release.tender.procurementMethodDetails ?? release.tender.procurementMethod,
    classifiers,
    budgetAmount: release.tender.value?.amount,
    currency: release.tender.value?.currency ?? "MXN",
    dates: {
      published: release.date,
      clarificationMeeting: release.tender.enquiryPeriod?.endDate,
      submissionDeadline: release.tender.tenderPeriod?.endDate,
      award: release.tender.awardPeriod?.startDate ?? awardDate,
    },
    status: release.tender.status ? OCDS_STATUS_TO_TENDER_STATUS[release.tender.status] ?? "unknown" : "unknown",
    statusRaw: release.tender.status,
    url: options.sourceUrl,
    attachments,
    state: findBuyerRegion(release) ?? options.defaultState,
    snapshot: {
      sourceUrl: options.sourceUrl,
      fetchedAt: options.fetchedAt,
      rawHash: hashRawPayload(rawPackage),
      httpStatus: options.httpStatus,
    },
  };

  return parseTenderRecord(raw);
}

/**
 * Parsea un release package OCDS 1.1 completo (JSON crudo ya deserializado)
 * y produce todos los `TenderRecord` válidos que contiene, ignorando
 * releases sin bloque `tender` (p.ej. releases de solo award/contract).
 */
export function mapOcdsPackageToTenderRecords(rawPackageJson: unknown, options: OcdsMapOptions): TenderRecord[] {
  const pkg = OcdsReleasePackageSchema.parse(rawPackageJson);
  const records: TenderRecord[] = [];
  for (const release of pkg.releases) {
    const record = mapOcdsReleaseToTenderRecord(release, rawPackageJson, options);
    if (record) records.push(record);
  }
  return records;
}
