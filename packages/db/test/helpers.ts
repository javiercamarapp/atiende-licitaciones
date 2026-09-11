import { createPgliteClient } from '../src/driver.js';
import { applyMigrations } from '../src/migrate.js';
import { withTenantContext, type TenantContext } from '../src/context.js';
import type { DbClient, DbExecutor } from '../src/driver.js';
import type { OrgRole } from '../src/roles.js';

/** Crea una base PGlite en memoria y aplica todas las migraciones reales. */
export async function createMigratedDb(): Promise<DbClient> {
  const db = await createPgliteClient();
  await applyMigrations(db);
  return db;
}

/** Ejecuta `fn` como el rol de aplicación con el contexto org/usuario dado. */
export async function asActor<T>(
  db: DbClient,
  ctx: TenantContext,
  fn: (tx: DbExecutor) => Promise<T>
): Promise<T> {
  return withTenantContext(db, ctx, fn);
}

export interface SeededOrg {
  orgId: string;
  slug: string;
}

/** Crea una organización directamente (como propietario de las migraciones, sin RLS). */
export async function seedOrg(db: DbClient, slug: string, name = slug): Promise<SeededOrg> {
  const { rows } = await db.query<{ id: string }>(
    'insert into organizations (name, slug) values ($1, $2) returning id',
    [name, slug]
  );
  return { orgId: rows[0].id, slug };
}

/** Crea un usuario global directamente. */
export async function seedUser(db: DbClient, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into users (email, password_hash) values ($1, 'test-hash') returning id",
    [email]
  );
  return rows[0].id;
}

/** Crea un usuario y lo hace miembro de una organización con un rol dado. */
export async function seedMember(db: DbClient, orgId: string, email: string, role: OrgRole): Promise<string> {
  const userId = await seedUser(db, email);
  await db.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, role]);
  return userId;
}

export async function seedSuperadmin(db: DbClient, email: string): Promise<string> {
  const userId = await seedUser(db, email);
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
  return userId;
}

/** Crea una convocatoria (tender) mínima en una organización, como propietario (sin RLS). */
export async function seedTender(db: DbClient, orgId: string, externalId: string, title = 'Tender'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into tenders (org_id, source, external_id, title) values ($1, 'test', $2, $3) returning id",
    [orgId, externalId, title]
  );
  return rows[0].id;
}

/**
 * Descripción de una tabla de dominio con org_id, para pruebas de aislamiento
 * genéricas: `insertRow(db, orgId, extra)` inserta una fila mínima válida
 * (como propietario, sin pasar por RLS) y devuelve su `id`.
 */
export interface DomainTableSpec {
  table: string;
  /** Inserta una fila válida en `orgId` y devuelve su id. Recibe ids auxiliares ya creados (tenderId, proposalId...). */
  insertRow(db: DbClient, orgId: string, aux: Record<string, string>): Promise<string>;
  /** Crea dependencias auxiliares necesarias en esa organización (p.ej. un tender) antes de insertar. */
  seedAux?(db: DbClient, orgId: string): Promise<Record<string, string>>;
}

async function insertTenderAux(db: DbClient, orgId: string): Promise<Record<string, string>> {
  const tenderId = await seedTender(db, orgId, `ext-${orgId}`);
  return { tenderId };
}

async function insertProposalAux(db: DbClient, orgId: string): Promise<Record<string, string>> {
  const tenderId = await seedTender(db, orgId, `ext-${orgId}-prop`);
  const { rows } = await db.query<{ id: string }>(
    "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
    [orgId, tenderId]
  );
  return { tenderId, proposalId: rows[0].id };
}

async function insertAgentRunAux(db: DbClient, orgId: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ id: string }>(
    "insert into agent_runs (org_id, agent_name) values ($1, 'test-agent') returning id",
    [orgId]
  );
  return { agentRunId: rows[0].id };
}

async function insertApprovedRateAux(db: DbClient, orgId: string): Promise<Record<string, string>> {
  const tenderId = await seedTender(db, orgId, `ext-${orgId}-rate`);
  const { rows: proposalRows } = await db.query<{ id: string }>(
    "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
    [orgId, tenderId]
  );
  const suffix = Math.random().toString(36).slice(2);
  const { rows: rateRows } = await db.query<{ id: string }>(
    `insert into approved_rates (org_id, item_code, description, unit_price, status, approved_at)
     values ($1, $2, 'Item de prueba', 100, 'approved', now()) returning id`,
    [orgId, `item-${suffix}`]
  );
  return { tenderId, proposalId: proposalRows[0].id, approvedRateId: rateRows[0].id };
}

/** Todas las tablas de dominio con org_id, con su forma de sembrar una fila válida. */
export const DOMAIN_TABLES: DomainTableSpec[] = [
  {
    table: 'tenders',
    async insertRow(db, orgId) {
      return seedTender(db, orgId, `ext-${orgId}-${Math.random()}`);
    },
  },
  {
    table: 'tender_matches',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        'insert into tender_matches (org_id, tender_id, score) values ($1, $2, 42) returning id',
        [orgId, aux.tenderId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'go_no_go_decisions',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into go_no_go_decisions (org_id, tender_id, decision) values ($1, $2, 'go') returning id",
        [orgId, aux.tenderId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'tender_documents',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into tender_documents (org_id, tender_id, storage_ref) values ($1, $2, 'ref') returning id",
        [orgId, aux.tenderId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'requirement_items',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into requirement_items (org_id, tender_id, description) values ($1, $2, 'req') returning id",
        [orgId, aux.tenderId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'compliance_items',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into compliance_items (org_id, tender_id, label) values ($1, $2, 'chk') returning id",
        [orgId, aux.tenderId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'proposals',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
        [orgId, aux.tenderId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'proposal_sections',
    seedAux: insertProposalAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into proposal_sections (org_id, proposal_id, section_key, title) values ($1, $2, 'intro', 'Intro') returning id",
        [orgId, aux.proposalId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'proposal_facts',
    seedAux: insertProposalAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id, page)
         values ($1, $2, 'technical:req-1:0', 'technical:req-1', 'La empresa cuenta con la capacidad "Auditoría".', 'clause', 'doc-bases-1', 12) returning id`,
        [orgId, aux.proposalId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'reviews',
    seedAux: insertProposalAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        'insert into reviews (org_id, proposal_id) values ($1, $2) returning id',
        [orgId, aux.proposalId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'submissions',
    seedAux: insertProposalAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        'insert into submissions (org_id, proposal_id) values ($1, $2) returning id',
        [orgId, aux.proposalId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'post_award_followups',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into post_award_followups (org_id, tender_id, kind, label) values ($1, $2, 'hito', 'Hito 1') returning id",
        [orgId, aux.tenderId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'agent_runs',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into agent_runs (org_id, agent_name) values ($1, 'test-agent') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'tool_calls',
    seedAux: insertAgentRunAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into tool_calls (org_id, agent_run_id, tool_name) values ($1, $2, 'search') returning id",
        [orgId, aux.agentRunId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'invitations',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into invitations (org_id, email, role, token_hash, expires_at) values ($1, $2, 'viewer', 'hash', now() + interval '1 day') returning id",
        [orgId, `invitee-${Math.random()}@example.com`]
      );
      return rows[0].id;
    },
  },
  {
    table: 'api_keys',
    async insertRow(db, orgId) {
      const suffix = Math.random().toString(36).slice(2);
      const { rows } = await db.query<{ id: string }>(
        "insert into api_keys (org_id, name, key_hash, key_prefix) values ($1, 'key', $2, 'ak_test') returning id",
        [orgId, `hash-${suffix}`]
      );
      return rows[0].id;
    },
  },
  {
    table: 'memberships',
    async insertRow(db, orgId) {
      const suffix = Math.random().toString(36).slice(2);
      const userId = await seedUser(db, `member-${suffix}@example.com`);
      const { rows } = await db.query<{ id: string }>(
        "insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer') returning id",
        [orgId, userId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'jobs',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into jobs (org_id, kind) values ($1, 'test-job') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'rate_limits',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into rate_limits (org_id, subject, route, window_start, window_seconds) values ($1, 'user-1', '/x', now(), 60) returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  // --- Ampliación back office (ver docs/AMPLIACION-BACKOFFICE.md) ---
  {
    table: 'company_profiles',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into company_profiles (org_id, legal_name) values ($1, 'Empresa de prueba') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'capabilities',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into capabilities (org_id, name) values ($1, 'Capacidad de prueba') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'experience_records',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into experience_records (org_id, title) values ($1, 'Proyecto de prueba') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'products_services',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into products_services (org_id, name) values ($1, 'Servicio de prueba') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'locations',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into locations (org_id, label) values ($1, 'Oficina de prueba') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'registrations',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into registrations (org_id, kind, value) values ($1, 'RFC', 'XAXX010101000') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'company_documents',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into company_documents (org_id, document_type, storage_ref) values ($1, 'acta_constitutiva', 'ref') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'authorized_signatories',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into authorized_signatories (org_id, full_name) values ($1, 'Firmante de prueba') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'restrictions',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into restrictions (org_id, kind) values ($1, 'conflicto_interes') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'field_provenance',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into field_provenance (org_id, entity, entity_id, field, source) values ($1, 'tenders', 'x', 'title', 'manual') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'tender_versions',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const suffix = Math.random().toString(36).slice(2);
      const { rows } = await db.query<{ id: string }>(
        "insert into tender_versions (org_id, tender_id, change_kind, source_version) values ($1, $2, 'publication', $3) returning id",
        [orgId, aux.tenderId, `v-${suffix}`]
      );
      return rows[0].id;
    },
  },
  {
    table: 'tender_change_events',
    seedAux: insertTenderAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into tender_change_events (org_id, tender_id, change_kind) values ($1, $2, 'amendment') returning id",
        [orgId, aux.tenderId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'approved_rates',
    async insertRow(db, orgId) {
      const suffix = Math.random().toString(36).slice(2);
      const { rows } = await db.query<{ id: string }>(
        "insert into approved_rates (org_id, item_code, description, unit_price) values ($1, $2, 'desc', 10) returning id",
        [orgId, `item-${suffix}`]
      );
      return rows[0].id;
    },
  },
  {
    table: 'proposal_pricing_lines',
    seedAux: insertApprovedRateAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 100, 100) returning id`,
        [orgId, aux.proposalId, aux.approvedRateId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'proposal_approvals',
    seedAux: insertProposalAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        "insert into proposal_approvals (org_id, proposal_id, approver_role) values ($1, $2, 'owner') returning id",
        [orgId, aux.proposalId]
      );
      return rows[0].id;
    },
  },
  {
    table: 'package_manifests',
    seedAux: insertProposalAux,
    async insertRow(db, orgId, aux) {
      const { rows } = await db.query<{ id: string }>(
        'insert into package_manifests (org_id, proposal_id) values ($1, $2) returning id',
        [orgId, aux.proposalId]
      );
      return rows[0].id;
    },
  },
  // --- Ronda 2 (0017_ronda2_extensions.sql) ---
  {
    table: 'incidents',
    async insertRow(db, orgId) {
      const { rows } = await db.query<{ id: string }>(
        "insert into incidents (org_id, title) values ($1, 'Incidente de prueba') returning id",
        [orgId]
      );
      return rows[0].id;
    },
  },
];
