import { z } from "zod";
import { optionalNullish } from "../../util/schema.js";

/**
 * Subconjunto permisivo del estándar OCDS 1.1 (Open Contracting Data
 * Standard, https://standard.open-contracting.org/1.1/es/) necesario para
 * mapear "release packages" a `TenderRecord`. No valida el esquema OCDS
 * completo (cientos de campos opcionales); solo los campos que este
 * conector consume. Compartido por `OcdsShcpConnector`, `PdnS6Connector` y
 * `StatePortalConnector`, que exponen el mismo patrón `/edca/...` (REQ-133,
 * REQ-135).
 *
 * Los campos opcionales usan `optionalNullish()` en vez de `.optional()` a
 * secas (SR-13): un release OCDS real que traiga `null` explícito para un
 * campo sin dato (patrón común en JSON de APIs gubernamentales) no debe
 * tumbar el `release` completo con un `ZodError` (`interface_changed`) --
 * debe tratarse igual que el campo ausente.
 */
export const OcdsValueSchema = z.object({
  amount: optionalNullish(z.number()),
  currency: optionalNullish(z.string()),
});

export const OcdsPeriodSchema = z.object({
  startDate: optionalNullish(z.string()),
  endDate: optionalNullish(z.string()),
});

export const OcdsClassificationSchema = z.object({
  scheme: optionalNullish(z.string()),
  id: optionalNullish(z.string()),
  description: optionalNullish(z.string()),
});

export const OcdsItemSchema = z.object({
  id: optionalNullish(z.string()),
  description: optionalNullish(z.string()),
  classification: optionalNullish(OcdsClassificationSchema),
});

export const OcdsDocumentSchema = z.object({
  id: optionalNullish(z.string()),
  documentType: optionalNullish(z.string()),
  title: optionalNullish(z.string()),
  url: optionalNullish(z.string()),
  format: optionalNullish(z.string()),
});

export const OcdsPartySchema = z.object({
  id: optionalNullish(z.string()),
  name: optionalNullish(z.string()),
  roles: optionalNullish(z.array(z.string())),
  address: optionalNullish(z.object({ region: optionalNullish(z.string()) }).partial()),
});

export const OcdsAwardSchema = z.object({
  id: optionalNullish(z.string()),
  date: optionalNullish(z.string()),
  status: optionalNullish(z.string()),
});

export const OcdsTenderSchema = z.object({
  id: optionalNullish(z.string()),
  title: optionalNullish(z.string()),
  description: optionalNullish(z.string()),
  status: optionalNullish(z.string()),
  procurementMethod: optionalNullish(z.string()),
  procurementMethodDetails: optionalNullish(z.string()),
  mainProcurementCategory: optionalNullish(z.string()),
  value: optionalNullish(OcdsValueSchema),
  tenderPeriod: optionalNullish(OcdsPeriodSchema),
  enquiryPeriod: optionalNullish(OcdsPeriodSchema),
  awardPeriod: optionalNullish(OcdsPeriodSchema),
  items: optionalNullish(z.array(OcdsItemSchema)),
  documents: optionalNullish(z.array(OcdsDocumentSchema)),
});

export const OcdsReleaseSchema = z.object({
  ocid: z.string(),
  id: z.string(),
  date: optionalNullish(z.string()),
  tag: optionalNullish(z.array(z.string())),
  initiationType: optionalNullish(z.string()),
  parties: optionalNullish(z.array(OcdsPartySchema)),
  buyer: optionalNullish(z.object({ id: optionalNullish(z.string()), name: optionalNullish(z.string()) })),
  tender: optionalNullish(OcdsTenderSchema),
  awards: optionalNullish(z.array(OcdsAwardSchema)),
});
export type OcdsRelease = z.infer<typeof OcdsReleaseSchema>;

/**
 * SR-19 (residual de la ronda 2 de corrección, ver `comprasmx-types.ts` para
 * el detalle completo): `releases` YA NO usa `.default([])`. Un cuerpo 200
 * sintácticamente válido pero sin la llave `releases` pasaba esta
 * validación SIN lanzar, indistinguible de un release package real con 0
 * releases. `{"releases": []}` explícito sigue siendo válido (colección
 * presente y vacía); la ausencia de la llave (o un valor no-array) ahora
 * lanza `ZodError` -> `interface_changed`.
 *
 * SR-24 (residual de SR-21, ver `docs/auditoria-1/sources-cierre-final.md`):
 * cada elemento de `releases` se valida como `z.unknown()` aquí (en vez de
 * `OcdsReleaseSchema` directamente) a propósito -- `mapOcdsPackageToTenderRecords`
 * (`ocds-mapper.ts`) hace el `OcdsReleaseSchema.safeParse()` POR RELEASE, para
 * poder reportar un release individual inválido en `dropped[]` (vía
 * `ConnectorContext.reportDropped`) en vez de que UN release malformado
 * tumbe el `release package` COMPLETO con un `ZodError` (perdiendo todos los
 * releases válidos de la misma página, el mismo antipatrón que SR-16
 * corrigió para el CSV histórico de ComprasMX). La llave `releases` en sí
 * sigue siendo obligatoria y debe ser un array (SR-19 arriba no cambia).
 */
export const OcdsReleasePackageSchema = z.object({
  uri: optionalNullish(z.string()),
  version: optionalNullish(z.string()),
  publishedDate: optionalNullish(z.string()),
  publisher: optionalNullish(z.object({ name: optionalNullish(z.string()) })),
  license: optionalNullish(z.string()),
  releases: z.array(z.unknown()),
});
export type OcdsReleasePackage = z.infer<typeof OcdsReleasePackageSchema>;
