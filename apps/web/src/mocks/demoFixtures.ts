// Datos de ejemplo de la demo pública (ronda 7, `/demo`) -- una
// organización ficticia ("Constructora Ejemplo S.A. de C.V.") con forma
// idéntica a la de los esquemas reales (lib/api/schemas.ts), servida SOLO
// en esta ruta por MSW (ver mocks/browser.ts). Nunca se mezclan con datos
// reales: DemoPage.tsx nunca importa `lib/api/client.ts` (el cliente que sí
// habla con apps/api) ni comparte ningún estado con AuthProvider/useAuth.
import type { AuditLogEntry, Followup, MatchResult, MyOrg, Tender } from "@/lib/api/schemas";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = () => Date.now();
const isoDaysAgo = (days: number) => new Date(now() - days * DAY_MS).toISOString();
const isoDaysFromNow = (days: number) => new Date(now() + days * DAY_MS).toISOString();

export const DEMO_ORG: MyOrg = {
  id: "demo-org-1",
  name: "Constructora Ejemplo S.A. de C.V.",
  slug: "constructora-ejemplo",
  role: "owner" as const,
};

export const DEMO_TENDERS: Tender[] = [
  {
    id: "demo-tender-1",
    source: "compranet",
    externalId: "DEMO-2026-001",
    title: "Mantenimiento de infraestructura vial — Zona Norte",
    contractingBody: "Secretaría de Infraestructura, Comunicaciones y Transportes",
    cpvCodes: ["45233141"],
    budgetAmount: 4500000,
    currency: "MXN",
    submissionDeadline: isoDaysFromNow(12),
    publishedAt: isoDaysAgo(2),
    url: null,
    status: "discovered" as const,
    createdAt: isoDaysAgo(2),
    updatedAt: isoDaysAgo(2),
  },
  {
    id: "demo-tender-2",
    source: "compranet",
    externalId: "DEMO-2026-002",
    title: "Suministro de equipo de cómputo para oficinas regionales",
    contractingBody: "Instituto Mexicano del Seguro Social",
    cpvCodes: ["30200000"],
    budgetAmount: 1200000,
    currency: "MXN",
    submissionDeadline: isoDaysFromNow(20),
    publishedAt: isoDaysAgo(5),
    url: null,
    status: "in_review" as const,
    createdAt: isoDaysAgo(5),
    updatedAt: isoDaysAgo(1),
  },
  {
    id: "demo-tender-3",
    source: "compranet",
    externalId: "DEMO-2026-003",
    title: "Servicios de consultoría en transformación digital",
    contractingBody: "Secretaría de Economía",
    cpvCodes: ["72000000"],
    budgetAmount: 800000,
    currency: "MXN",
    submissionDeadline: isoDaysFromNow(35),
    publishedAt: isoDaysAgo(18),
    url: null,
    status: "in_progress" as const,
    createdAt: isoDaysAgo(18),
    updatedAt: isoDaysAgo(3),
  },
  {
    id: "demo-tender-4",
    source: "compranet",
    externalId: "DEMO-2026-004",
    title: "Construcción de puente vehicular — Tramo Sur",
    contractingBody: "Gobierno del Estado",
    cpvCodes: ["45221100"],
    budgetAmount: 12000000,
    currency: "MXN",
    submissionDeadline: isoDaysAgo(10),
    publishedAt: isoDaysAgo(60),
    url: null,
    status: "won" as const,
    createdAt: isoDaysAgo(60),
    updatedAt: isoDaysAgo(10),
  },
];

export const DEMO_MATCHES: MatchResult[] = [
  {
    tenderId: "demo-tender-1",
    tenderKey: "DEMO-2026-001",
    relevance: { score: 82, criteria: [{ criterion: "Giro (CPV)", score: 40, maxScore: 40, explanation: "Coincide con obra vial" }] },
    eligibility: { status: "cumple" as const, criteria: [{ requirement: "Capacidad técnica", status: "cumple" as const, explanation: "Experiencia verificable en obra similar" }] },
    missingProfileFields: [] as string[],
  },
  {
    tenderId: "demo-tender-2",
    tenderKey: "DEMO-2026-002",
    relevance: { score: 45, criteria: [{ criterion: "Giro (CPV)", score: 15, maxScore: 40, explanation: "Fuera del giro principal" }] },
    eligibility: { status: "no_evaluable" as const, criteria: [] as { requirement: string; status: "cumple" | "no_cumple" | "no_evaluable"; explanation: string }[] },
    missingProfileFields: ["capabilities_or_products"],
  },
  {
    tenderId: "demo-tender-3",
    tenderKey: "DEMO-2026-003",
    relevance: { score: 91, criteria: [{ criterion: "Giro (CPV)", score: 40, maxScore: 40, explanation: "Coincide con consultoría de TI" }] },
    eligibility: { status: "cumple" as const, criteria: [{ requirement: "Capacidad técnica", status: "cumple" as const, explanation: "Perfil de empresa completo" }] },
    missingProfileFields: [] as string[],
  },
];

export const DEMO_POST_AWARD_ALERTS: Followup[] = [
  {
    id: "demo-followup-1",
    tenderId: "demo-tender-4",
    kind: "garantia",
    label: "Garantía de cumplimiento — Puente vehicular",
    dueDate: isoDaysFromNow(5),
    status: "pending" as const,
    amount: 600000,
    notes: null,
    legalReference: null,
    reminderLeadDays: 10,
    jobId: null,
    createdAt: isoDaysAgo(10),
    calendarNote: null,
    legalRegime: null,
    alertLevel: "proximo" as const,
  },
  {
    id: "demo-followup-2",
    tenderId: "demo-tender-4",
    kind: "pago",
    label: "Pago de estimación 1",
    dueDate: isoDaysAgo(2),
    status: "in_progress" as const,
    amount: 2000000,
    notes: null,
    legalReference: "LAASSP Art. 73",
    reminderLeadDays: 5,
    jobId: null,
    createdAt: isoDaysAgo(15),
    calendarNote: null,
    legalRegime: {
      law: "LAASSP",
      article: "73",
      dofDate: "2025-04-16",
      effectiveDate: "2025-04-17",
      unit: "dias_habiles" as const,
      days: 17,
      reason: "Plazo de pago tras verificación de factura",
    },
    alertLevel: "vencido" as const,
  },
];

export const DEMO_AUDIT_LOG: AuditLogEntry[] = [
  {
    id: "demo-audit-1",
    orgId: DEMO_ORG.id,
    actorId: "demo-user-1",
    action: "update",
    entity: "company_profile",
    entityId: "demo-profile-1",
    before: null,
    after: null,
    requestId: "demo-request-1",
    correlationId: null,
    createdAt: isoDaysAgo(1),
  },
  {
    id: "demo-audit-2",
    orgId: DEMO_ORG.id,
    actorId: "demo-user-1",
    action: "approve",
    entity: "rates",
    entityId: "demo-rate-1",
    before: null,
    after: null,
    requestId: "demo-request-2",
    correlationId: null,
    createdAt: isoDaysAgo(3),
  },
  {
    id: "demo-audit-3",
    orgId: DEMO_ORG.id,
    actorId: "demo-user-2",
    action: "create",
    entity: "tender_documents",
    entityId: "demo-tender-1",
    before: null,
    after: null,
    requestId: "demo-request-3",
    correlationId: null,
    createdAt: isoDaysAgo(6),
  },
];
