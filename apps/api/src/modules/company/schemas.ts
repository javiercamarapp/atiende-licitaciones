import { z } from 'zod';

// ---------------------------------------------------------------------------
// company_profiles (singleton por organización)
// ---------------------------------------------------------------------------
export const companyProfileUpsertSchema = z.object({
  legalName: z.string().min(1),
  tradeName: z.string().min(1).optional(),
  taxId: z.string().min(1).optional(),
  description: z.string().optional(),
  sector: z.string().optional(),
  foundedYear: z.number().int().min(1800).max(2100).optional(),
  employeeCount: z.number().int().min(0).optional(),
  annualRevenue: z.number().min(0).optional(),
  website: z.string().url().optional(),
});
export type CompanyProfileUpsert = z.infer<typeof companyProfileUpsertSchema>;

export const companyProfileSchema = z.object({
  id: z.string().uuid(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  taxId: z.string().nullable(),
  description: z.string().nullable(),
  sector: z.string().nullable(),
  foundedYear: z.number().nullable(),
  employeeCount: z.number().nullable(),
  annualRevenue: z.number().nullable(),
  website: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------
export const capabilityCreateSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  description: z.string().optional(),
  isVerified: z.boolean().optional(),
  evidenceRef: z.string().optional(),
});
export const capabilityUpdateSchema = capabilityCreateSchema.partial();
export const capabilitySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  isVerified: z.boolean(),
  evidenceRef: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// experience_records (REQ-143: sin evidenceRef -> no verificable, excluida de elegibilidad)
// ---------------------------------------------------------------------------
export const experienceCreateSchema = z.object({
  title: z.string().min(1),
  clientName: z.string().optional(),
  description: z.string().optional(),
  contractValue: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  isVerified: z.boolean().optional(),
  evidenceRef: z.string().optional(),
});
export const experienceUpdateSchema = experienceCreateSchema.partial();
export const experienceSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  clientName: z.string().nullable(),
  description: z.string().nullable(),
  contractValue: z.number().nullable(),
  currency: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  isVerified: z.boolean(),
  evidenceRef: z.string().nullable(),
  verifiable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// products_services
// ---------------------------------------------------------------------------
export const productServiceCreateSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  description: z.string().optional(),
});
export const productServiceUpdateSchema = productServiceCreateSchema.partial();
export const productServiceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// locations
// ---------------------------------------------------------------------------
export const locationCreateSchema = z.object({
  label: z.string().min(1),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  isPrimary: z.boolean().optional(),
});
export const locationUpdateSchema = locationCreateSchema.partial();
export const locationSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  postalCode: z.string().nullable(),
  isPrimary: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// registrations (RFC, padrones, licencias)
// ---------------------------------------------------------------------------
export const registrationCreateSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
  issuingAuthority: z.string().optional(),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
});
export const registrationUpdateSchema = registrationCreateSchema.partial();
export const registrationSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  value: z.string(),
  issuingAuthority: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// authorized_signatories
// ---------------------------------------------------------------------------
export const signatoryCreateSchema = z.object({
  fullName: z.string().min(1),
  roleTitle: z.string().optional(),
  idDocumentRef: z.string().optional(),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
});
export const signatoryUpdateSchema = signatoryCreateSchema.partial();
export const signatorySchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  roleTitle: z.string().nullable(),
  idDocumentRef: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// restrictions
// ---------------------------------------------------------------------------
export const restrictionCreateSchema = z.object({
  kind: z.string().min(1),
  description: z.string().optional(),
  validUntil: z.string().optional(),
});
export const restrictionUpdateSchema = restrictionCreateSchema.partial();
export const restrictionSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  description: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// company_documents (metadatos + vigencia; archivo en disco vía STORAGE_DIR)
// ---------------------------------------------------------------------------
export const documentCreateSchema = z.object({
  documentType: z.string().min(1),
  contentBase64: z.string().min(1),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
});
export const documentSchema = z.object({
  id: z.string().uuid(),
  documentType: z.string(),
  storageRef: z.string(),
  fileHash: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  status: z.enum(['valid', 'expiring_soon', 'expired', 'pending_verification']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// approved_rates (propuesta por writer, aprobación por owner/admin)
// ---------------------------------------------------------------------------
export const rateCreateSchema = z.object({
  itemCode: z.string().min(1),
  description: z.string().min(1),
  unit: z.string().optional(),
  unitPrice: z.number().min(0),
  currency: z.string().length(3).optional(),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
});
export const rateSchema = z.object({
  id: z.string().uuid(),
  itemCode: z.string(),
  description: z.string(),
  unit: z.string(),
  unitPrice: z.number(),
  currency: z.string(),
  status: z.enum(['draft', 'approved', 'archived']),
  approvedBy: z.string().uuid().nullable(),
  approvedAt: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
