import { z } from "zod";

/**
 * Subconjunto permisivo del estándar OCDS 1.1 (Open Contracting Data
 * Standard, https://standard.open-contracting.org/1.1/es/) necesario para
 * mapear "release packages" a `TenderRecord`. No valida el esquema OCDS
 * completo (cientos de campos opcionales); solo los campos que este
 * conector consume. Compartido por `OcdsShcpConnector`, `PdnS6Connector` y
 * `StatePortalConnector`, que exponen el mismo patrón `/edca/...` (REQ-133,
 * REQ-135).
 */
export const OcdsValueSchema = z.object({
  amount: z.number().optional(),
  currency: z.string().optional(),
});

export const OcdsPeriodSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const OcdsClassificationSchema = z.object({
  scheme: z.string().optional(),
  id: z.string().optional(),
  description: z.string().optional(),
});

export const OcdsItemSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  classification: OcdsClassificationSchema.optional(),
});

export const OcdsDocumentSchema = z.object({
  id: z.string().optional(),
  documentType: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  format: z.string().optional(),
});

export const OcdsPartySchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  roles: z.array(z.string()).optional(),
  address: z.object({ region: z.string().optional() }).partial().optional(),
});

export const OcdsAwardSchema = z.object({
  id: z.string().optional(),
  date: z.string().optional(),
  status: z.string().optional(),
});

export const OcdsTenderSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  procurementMethod: z.string().optional(),
  procurementMethodDetails: z.string().optional(),
  mainProcurementCategory: z.string().optional(),
  value: OcdsValueSchema.optional(),
  tenderPeriod: OcdsPeriodSchema.optional(),
  enquiryPeriod: OcdsPeriodSchema.optional(),
  awardPeriod: OcdsPeriodSchema.optional(),
  items: z.array(OcdsItemSchema).optional(),
  documents: z.array(OcdsDocumentSchema).optional(),
});

export const OcdsReleaseSchema = z.object({
  ocid: z.string(),
  id: z.string(),
  date: z.string().optional(),
  tag: z.array(z.string()).optional(),
  initiationType: z.string().optional(),
  parties: z.array(OcdsPartySchema).optional(),
  buyer: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
  tender: OcdsTenderSchema.optional(),
  awards: z.array(OcdsAwardSchema).optional(),
});
export type OcdsRelease = z.infer<typeof OcdsReleaseSchema>;

export const OcdsReleasePackageSchema = z.object({
  uri: z.string().optional(),
  version: z.string().optional(),
  publishedDate: z.string().optional(),
  publisher: z.object({ name: z.string().optional() }).optional(),
  license: z.string().optional(),
  releases: z.array(OcdsReleaseSchema).default([]),
});
export type OcdsReleasePackage = z.infer<typeof OcdsReleasePackageSchema>;
