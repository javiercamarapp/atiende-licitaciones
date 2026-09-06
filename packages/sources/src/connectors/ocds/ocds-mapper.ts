import { hashRawPayload } from "../../util/hash.js";
import { fromMexicoCityNaive } from "../../util/timezone.js";
import type { ClassifierScheme, ProcedureType, SourceId, TenderRecord, TenderStatus } from "../../types/tender-record.js";
import { parseTenderRecord } from "../../types/tender-record.js";
import type { DroppedRecordInfo } from "../types.js";
import { OcdsReleasePackageSchema, OcdsReleaseSchema, type OcdsRelease } from "./ocds-types.js";

/**
 * Convierte una fecha OCDS a `Date` pasando por `fromMexicoCityNaive()`
 * (SR-02): el estándar OCDS 1.1 exige ISO 8601 CON offset explícito, así que
 * en la práctica esto es un passthrough (`fromMexicoCityNaive` respeta un
 * offset ya presente). Es una defensa explícita, no teórica: un portal
 * estatal (REQ-135) que no siga el estándar al pie de la letra y emita una
 * fecha/hora naive NO debe quedar a merced del TZ del proceso que ejecuta el
 * conector, igual que ComprasMX/DOF.
 */
function parseOcdsDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  return fromMexicoCityNaive(raw);
}

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
      published: parseOcdsDate(release.date),
      clarificationMeeting: parseOcdsDate(release.tender.enquiryPeriod?.endDate),
      submissionDeadline: parseOcdsDate(release.tender.tenderPeriod?.endDate),
      award: parseOcdsDate(release.tender.awardPeriod?.startDate ?? awardDate),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SR-24 (ALTA, residual de SR-21 -- ver `docs/auditoria-1/sources-cierre-final.md`):
 * antes de esta ronda, `mapOcdsPackageToTenderRecords` devolvía solo
 * `TenderRecord[]`, descartando en silencio (sin ninguna entrada en
 * `errors[]`/`dropped[]`, sin cambiar `health.state`) cualquier release sin
 * bloque `tender` -- confirmado end-to-end: un release package con 80% de
 * sus releases sin `tender` (simulando un cambio de interfaz real donde el
 * campo se movió/renombró) producía `health.state="ok"`, `dropped:[]`,
 * porque `create-ocds-connector.ts` (compartido por SHCP/PDN-S6/portales
 * estatales) nunca invocaba `ctx.reportDropped` -- a diferencia de
 * `mapComprasMxApiRecords`, que sí lo hace desde la ronda de SR-21. Mismo
 * patrón `{records, dropped}` que esa función, para que
 * `createOcdsConnector`/`createStatePortalConnector` reenvíen cada entrada a
 * `ctx.reportDropped()` y el umbral de tasa de descarte (`dropRateThreshold`)
 * proteja también a estas 3 fuentes.
 */
export interface OcdsPackageMapResult {
  records: TenderRecord[];
  dropped: DroppedRecordInfo[];
}

/**
 * Parsea un release package OCDS 1.1 completo (JSON crudo ya deserializado)
 * y produce todos los `TenderRecord` válidos que contiene. Cada release se
 * valida INDIVIDUALMENTE (`OcdsReleaseSchema.safeParse`, SR-24): un release
 * que no cumple el esquema esperado se reporta en `dropped[]` con el motivo
 * del `ZodError` en vez de tumbar el release package COMPLETO (el mismo
 * antipatrón que SR-16 corrigió para el CSV histórico de ComprasMX). Un
 * release válido pero sin bloque `tender` (p.ej. un release de solo
 * adjudicación/contrato -- filtro por diseño, no un error de datos) también
 * se reporta en `dropped[]`: filtrar sigue siendo la decisión correcta, pero
 * hacerlo SIN reportarlo es indistinguible de un cambio de interfaz real
 * donde el campo `tender` se movió/renombró (SR-24).
 */
export function mapOcdsPackageToTenderRecords(rawPackageJson: unknown, options: OcdsMapOptions): OcdsPackageMapResult {
  const pkg = OcdsReleasePackageSchema.parse(rawPackageJson);
  const records: TenderRecord[] = [];
  const dropped: DroppedRecordInfo[] = [];

  pkg.releases.forEach((rawRelease, index) => {
    const parsed = OcdsReleaseSchema.safeParse(rawRelease);
    if (!parsed.success) {
      dropped.push({
        index,
        reason: `Release no cumple el esquema OCDS esperado: ${parsed.error.message}`,
        fields: isPlainObject(rawRelease) ? rawRelease : undefined,
      });
      return;
    }
    const release = parsed.data;

    if (!release.tender) {
      dropped.push({
        index,
        externalId: release.ocid,
        reason:
          "Release OCDS sin bloque 'tender' (filtrado por diseño: solo adjudicación/contrato, no es una convocatoria -- " +
          "reportado para que una tasa alta de este filtro, indicio de un cambio de interfaz real, no pase inadvertida)",
        fields: { ocid: release.ocid, id: release.id, tag: release.tag },
      });
      return;
    }

    const record = mapOcdsReleaseToTenderRecord(release, rawPackageJson, options);
    if (!record) {
      // Defensivo: no debería ocurrir dado que `release.tender` ya se validó arriba, pero se reporta igual en
      // vez de descartar en silencio si `mapOcdsReleaseToTenderRecord` cambiara su criterio (mismo patrón que
      // `mapComprasMxApiRecords`).
      dropped.push({ index, externalId: release.ocid, reason: "Release descartado por mapOcdsReleaseToTenderRecord (motivo no determinado por el llamador)" });
      return;
    }
    records.push(record);
  });

  return { records, dropped };
}
