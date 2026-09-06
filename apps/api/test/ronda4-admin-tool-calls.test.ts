import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, enrollTwoFactorFull, stepUpWithBackupCode } from './helpers.js';

async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

async function seedPendingToolCall(db: DbClient, orgId: string): Promise<string> {
  const run = await db.query<{ id: string }>("insert into agent_runs (org_id, agent_name) values ($1, 'test-agent') returning id", [orgId]);
  const tc = await db.query<{ id: string }>(
    "insert into tool_calls (org_id, agent_run_id, tool_name) values ($1, $2, 'search') returning id",
    [orgId, run.rows[0].id]
  );
  return tc.rows[0].id;
}

/**
 * Ronda 4, item 3 (docs/logs/api-ronda4.log): apps/web (README) señaló que
 * `GET /admin/approvals` lista tool_calls pendientes de TODAS las
 * organizaciones, pero aprobar/denegar de verdad exigía `X-Org-Id` + rol
 * owner/admin DE ESA organización -- un superadmin no necesariamente lo es,
 * dejando la pantalla de solo lectura. `POST /admin/tool-calls/:id/approve|deny`
 * gatea por `app.requireSuperadmin` (platform_admins), cross-org, sin
 * `X-Org-Id`.
 *
 * R5-11 (docs/auditoria-2/api-r5-09-10-reverificacion.md): además del rol
 * superadmin, esta aprobación cross-org exige AHORA verificación en dos
 * pasos (TOTP) reciente, con `purpose: 'admin.action'` -- atada a la
 * organización DUEÑA de la tool_call concreta (esta ruta nunca lleva
 * X-Org-Id; ver comentario en modules/admin/routes.ts). Un superadmin sin
 * 2FA enrolado recibe el mismo 403 con instrucción que cualquier otro
 * consumidor de `requireStepUp`.
 */
describe('POST /admin/tool-calls/:id/approve|deny (ronda 4, superadmin cross-org)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('un usuario normal (no superadmin) recibe 403 en approve y en deny', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 1', 'atc-org-1');
    const toolCallId = await seedPendingToolCall(db, org.id);

    const approve = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(approve.statusCode).toBe(403);

    const deny = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/deny`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(deny.statusCode).toBe(403);
  });

  it('R5-11: un superadmin SIN 2FA enrolado recibe 403 con instrucción explícita de enrolar, aunque el rol sea correcto', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 6', 'atc-org-6');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-6@example.com');
    await makeSuperadmin(db, superadminUser.id);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().title).toContain('POST /auth/2fa/enroll');

    // La fila sigue pendiente -- el 403 ocurrió ANTES de tocar la fila.
    const row = await db.query<{ authorization_status: string }>('select authorization_status from tool_calls where id = $1', [toolCallId]);
    expect(row.rows[0].authorization_status).toBe('pending');
  });

  it('R5-11: superadmin enrolado pero SIN X-Step-Up recibe 403 pidiendo el encabezado', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-7@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 7', 'atc-org-7');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-7@example.com');
    await makeSuperadmin(db, superadminUser.id);
    await enrollTwoFactor(app, superadminUser.accessToken, { orgId: org.id, purpose: 'admin.action' });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().title).toContain('X-Step-Up');
  });

  it('R5-11: un stepUpToken con purpose incorrecto (p.ej. tool_call.approval en lugar de admin.action) es rechazado con 403', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-8@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 8', 'atc-org-8');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-8@example.com');
    await makeSuperadmin(db, superadminUser.id);
    // Se enrola y se pide un step-up para OTRO purpose (org-scoped, no admin.action).
    const { stepUpToken } = await enrollTwoFactor(app, superadminUser.accessToken, { orgId: org.id, purpose: 'tool_call.approval' });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'x-step-up': stepUpToken },
    });
    expect(res.statusCode).toBe(403);

    const row = await db.query<{ authorization_status: string }>('select authorization_status from tool_calls where id = $1', [toolCallId]);
    expect(row.rows[0].authorization_status).toBe('pending');
  });

  it('un superadmin (sin ser owner/admin de la organización dueña) SÍ puede aprobar cross-org con step-up vigente, y queda en audit_log con la org afectada', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 2', 'atc-org-2');
    const toolCallId = await seedPendingToolCall(db, org.id);

    const superadminUser = await registerAndLogin(app, 'atc-superadmin-2@example.com');
    await makeSuperadmin(db, superadminUser.id);
    // Verifica explícitamente que el superadmin NO es miembro de la organización dueña.
    const membership = await db.query('select 1 from memberships where org_id = $1 and user_id = $2', [org.id, superadminUser.id]);
    expect(membership.rows.length).toBe(0);

    // R5-11: el step-up se pide atado a la organización DUEÑA de la
    // tool_call (aunque el superadmin no sea miembro -- crear la sesión no
    // exige membresía, ver modules/twofa/routes.ts).
    const { stepUpToken } = await enrollTwoFactor(app, superadminUser.accessToken, { orgId: org.id, purpose: 'admin.action' });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'x-step-up': stepUpToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizationStatus).toBe('approved');

    // La sesión de step-up quedó consumida (de un solo uso).
    const session = await db.query<{ consumed_at: string | null }>('select consumed_at from step_up_sessions where id = $1', [stepUpToken]);
    expect(session.rows[0].consumed_at).not.toBeNull();

    const audit = await db.query(
      "select org_id, actor_id, action from audit_log where entity = 'tool_calls' and entity_id = $1 and action = 'admin.tool_call.approve'",
      [toolCallId]
    );
    expect(audit.rows.length).toBe(1);
    expect((audit.rows[0] as any).org_id).toBe(org.id);
    expect((audit.rows[0] as any).actor_id).toBe(superadminUser.id);
  });

  it('doble aprobación de la MISMA tool_call responde 409 en el segundo intento (cada intento con su propio step-up)', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 3', 'atc-org-3');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-3@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const { backupCodes, stepUpToken } = await enrollTwoFactorFull(app, superadminUser.accessToken, { orgId: org.id, purpose: 'admin.action' });

    const first = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'x-step-up': stepUpToken },
    });
    expect(first.statusCode).toBe(200);

    // Una sesión de step-up es de un solo uso -- se pide una nueva para el
    // segundo intento (que de todos modos debe fallar, ahora por 409).
    const secondStepUp = await stepUpWithBackupCode(app, superadminUser.accessToken, backupCodes[0], { orgId: org.id, purpose: 'admin.action' });
    const second = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'x-step-up': secondStepUp },
    });
    expect(second.statusCode).toBe(409);
  });

  it('deny también funciona cross-org para un superadmin, con step-up vigente', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 4', 'atc-org-4');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-4@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const { stepUpToken } = await enrollTwoFactor(app, superadminUser.accessToken, { orgId: org.id, purpose: 'admin.action' });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/deny`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'x-step-up': stepUpToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizationStatus).toBe('denied');
  });

  it('una tool_call inexistente responde 404 SIN exigir step-up (nada que autorizar todavía)', async () => {
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-5@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${'00000000-0000-0000-0000-000000000000'}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
