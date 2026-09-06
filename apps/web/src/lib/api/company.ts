import { apiRequest } from "./client";
import {
  companyProfileSchema,
  capabilitySchema,
  signatorySchema,
  documentSchema,
  rateSchema,
  experienceSchema,
  type CompanyProfile,
  type Capability,
  type Signatory,
  type CompanyDocument,
  type Rate,
  type Experience,
} from "./schemas";
import { z } from "zod";

export interface CompanyProfileInput {
  legalName: string;
  tradeName?: string;
  taxId?: string;
  description?: string;
  sector?: string;
  foundedYear?: number;
  employeeCount?: number;
  annualRevenue?: number;
  website?: string;
}

export async function getCompanyProfile(orgId: string): Promise<CompanyProfile | null> {
  const raw = await apiRequest<unknown>("/company/profile", { orgId });
  return companyProfileSchema.nullable().parse(raw);
}

export async function saveCompanyProfile(orgId: string, input: CompanyProfileInput): Promise<CompanyProfile> {
  const raw = await apiRequest<unknown>("/company/profile", { method: "PUT", body: input, orgId });
  return companyProfileSchema.parse(raw);
}

// --- capabilities ------------------------------------------------------------
export interface CapabilityInput {
  name: string;
  category?: string;
  description?: string;
  isVerified?: boolean;
  evidenceRef?: string;
}

export async function listCapabilities(orgId: string): Promise<Capability[]> {
  const raw = await apiRequest<unknown>("/company/capabilities", { orgId });
  return z.array(capabilitySchema).parse(raw);
}

export async function createCapability(orgId: string, input: CapabilityInput): Promise<Capability> {
  const raw = await apiRequest<unknown>("/company/capabilities", { method: "POST", body: input, orgId });
  return capabilitySchema.parse(raw);
}

export async function deleteCapability(orgId: string, id: string): Promise<void> {
  await apiRequest<void>(`/company/capabilities/${id}`, { method: "DELETE", orgId });
}

// --- signatories ---------------------------------------------------------------
export interface SignatoryInput {
  fullName: string;
  roleTitle?: string;
  idDocumentRef?: string;
  validFrom?: string;
  validUntil?: string;
}

export async function listSignatories(orgId: string): Promise<Signatory[]> {
  const raw = await apiRequest<unknown>("/company/signatories", { orgId });
  return z.array(signatorySchema).parse(raw);
}

export async function createSignatory(orgId: string, input: SignatoryInput): Promise<Signatory> {
  const raw = await apiRequest<unknown>("/company/signatories", { method: "POST", body: input, orgId });
  return signatorySchema.parse(raw);
}

export async function deleteSignatory(orgId: string, id: string): Promise<void> {
  await apiRequest<void>(`/company/signatories/${id}`, { method: "DELETE", orgId });
}

// --- documents -------------------------------------------------------------------
export interface DocumentInput {
  documentType: string;
  contentBase64: string;
  validFrom?: string;
  validUntil?: string;
}

export async function listDocuments(orgId: string): Promise<CompanyDocument[]> {
  const raw = await apiRequest<unknown>("/company/documents", { orgId });
  return z.array(documentSchema).parse(raw);
}

export async function uploadDocument(orgId: string, input: DocumentInput): Promise<CompanyDocument> {
  const raw = await apiRequest<unknown>("/company/documents", { method: "POST", body: input, orgId });
  return documentSchema.parse(raw);
}

export async function deleteDocument(orgId: string, id: string): Promise<void> {
  await apiRequest<void>(`/company/documents/${id}`, { method: "DELETE", orgId });
}

// --- rates (propuesta -> aprobación) ----------------------------------------------
export interface RateInput {
  itemCode: string;
  description: string;
  unit?: string;
  unitPrice: number;
  currency?: string;
  validFrom?: string;
  validUntil?: string;
}

export async function listRates(orgId: string): Promise<Rate[]> {
  const raw = await apiRequest<unknown>("/company/rates", { orgId });
  return z.array(rateSchema).parse(raw);
}

export async function proposeRate(orgId: string, input: RateInput): Promise<Rate> {
  const raw = await apiRequest<unknown>("/company/rates", { method: "POST", body: input, orgId });
  return rateSchema.parse(raw);
}

export async function approveRate(orgId: string, id: string): Promise<Rate> {
  const raw = await apiRequest<unknown>(`/company/rates/${id}/approve`, { method: "POST", orgId });
  return rateSchema.parse(raw);
}

export async function rejectRate(orgId: string, id: string): Promise<Rate> {
  const raw = await apiRequest<unknown>(`/company/rates/${id}/reject`, { method: "POST", orgId });
  return rateSchema.parse(raw);
}

// --- experience (solo lectura desde apps/web: usada como fuente de la
// propuesta técnica en Redacción, ver src/pages/preparacion/RedaccionPage.tsx.
// La API sí expone POST/PATCH/DELETE, pero esta ronda no agrega su propia
// pantalla de CRUD -- fuera del alcance despachado.) --------------------------
export async function listExperience(orgId: string): Promise<Experience[]> {
  const raw = await apiRequest<unknown>("/company/experience", { orgId });
  return z.array(experienceSchema).parse(raw);
}
