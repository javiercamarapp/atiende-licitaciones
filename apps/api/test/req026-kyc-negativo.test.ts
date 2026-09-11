import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * REQ-026 (docs/REQUISITOS.md, tolerancia cero): "Un RFC presente en la
 * lista 69-B definitiva suspende automáticamente el alta del tenant". Estas
 * pruebas siembran `sanctions_69b_snapshots`/`sanctions_69b_entries`
 * directamente (como propietario de las migraciones, sin RLS -- es la
 * misma tabla que en producción llena el job nocturno de `apps/worker`,
 * ver `apps/worker/test/kyc-screening-handler.test.ts` para la ingesta en
 * sí) para poder probar el cruce end-to-end de `PUT /company/profile` sin
 * depender de un fetch real al SAT en cada corrida de este suite.
 */
async function seedNegativeListEntry(db: DbClient, rfc: string, situacion: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `insert into sanctions_69b_snapshots (source_url, fetched_at, list_as_of_date, list_as_of_raw, record_count, raw_hash)
     values ('http://test', now(), '2026-01-01', 'leyenda de prueba', 1, $1) returning id`,
    [`hash-${rfc}`]
  );
  await db.query(
    `insert into sanctions_69b_entries (rfc, nombre_contribuyente, situacion, snapshot_id, first_seen_snapshot_id)
     values ($1, $2, $3, $4, $4)`,
    [rfc, `Empresa de prueba ${rfc}`, situacion, rows[0].id]
  );
}

describe('REQ-026: KYC negativo (lista 69-B) al capturar el RFC del perfil de empresa', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('RFC en 69-B "Definitivo": PUT /company/profile se rechaza con 403 kyc-suspended y el perfil NUNCA se guarda con ese RFC', async () => {
    await seedNegativeListEntry(db, 'DEF010101AB1', 'Definitivo');
    const owner = await registerAndLogin(app, 'kyc-suspend-owner@example.com');
    const org = await createOrgFor(app, owner, 'Empresa Suspendida', 'kyc-suspend-org');

    const put = await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { legalName: 'Empresa Suspendida SA de CV', taxId: 'def010101ab1' },
    });
    expect(put.statusCode).toBe(403);
    expect(put.json().type).toBe('https://atiende.example/errors/kyc-suspended');

    const profile = await db.query('select 1 from company_profiles where org_id = $1', [org.id]);
    expect(profile.rows).toHaveLength(0);

    const status = await db.query<{ verdict: string; reason: string }>('select verdict, reason from tenant_kyc_status where org_id = $1', [org.id]);
    expect(status.rows[0].verdict).toBe('suspended');
    expect(status.rows[0].reason).toBe('Definitivo');

    const checks = await db.query<{ trigger: string; rfc_checked: string }>('select trigger, rfc_checked from tenant_kyc_checks where org_id = $1', [org.id]);
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0].trigger).toBe('alta');
    expect(checks.rows[0].rfc_checked).toBe('DEF010101AB1');
  });

  it('tenant suspendido queda bloqueado en TODA ruta de requireOrg, no solo en la que capturó el RFC', async () => {
    await seedNegativeListEntry(db, 'BLK020202CD2', 'Definitivo');
    const owner = await registerAndLogin(app, 'kyc-blocked-everywhere@example.com');
    const org = await createOrgFor(app, owner, 'Empresa Bloqueada', 'kyc-blocked-org');

    const put = await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { legalName: 'Empresa Bloqueada', taxId: 'BLK020202CD2' },
    });
    expect(put.statusCode).toBe(403);

    // Cualquier otra ruta que dependa de requireOrg (no solo /company/profile) queda bloqueada.
    const getProfile = await app.inject({
      method: 'GET',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(getProfile.statusCode).toBe(403);
    expect(getProfile.json().type).toBe('https://atiende.example/errors/kyc-suspended');

    const listCapabilities = await app.inject({
      method: 'GET',
      url: '/company/capabilities',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(listCapabilities.statusCode).toBe(403);
  });

  it('caso negativo: un RFC que no aparece en 69-B se guarda normalmente y el tenant NO queda bloqueado', async () => {
    const owner = await registerAndLogin(app, 'kyc-clear-owner@example.com');
    const org = await createOrgFor(app, owner, 'Empresa Limpia', 'kyc-clear-org');

    const put = await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { legalName: 'Empresa Limpia SA de CV', taxId: 'CLR030303EF3' },
    });
    expect(put.statusCode).toBe(200);

    const status = await db.query<{ verdict: string }>('select verdict from tenant_kyc_status where org_id = $1', [org.id]);
    expect(status.rows[0].verdict).toBe('clear');

    const getProfile = await app.inject({
      method: 'GET',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(getProfile.statusCode).toBe(200);
  });

  it('RFC en 69-B "Presunto": el perfil SÍ se guarda (aún desvirtuable) pero el veredicto queda flagged para revisión', async () => {
    await seedNegativeListEntry(db, 'PRE040404GH4', 'Presunto');
    const owner = await registerAndLogin(app, 'kyc-flagged-owner@example.com');
    const org = await createOrgFor(app, owner, 'Empresa En Revision', 'kyc-flagged-org');

    const put = await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { legalName: 'Empresa En Revisión SA de CV', taxId: 'PRE040404GH4' },
    });
    expect(put.statusCode).toBe(200);

    const status = await db.query<{ verdict: string }>('select verdict from tenant_kyc_status where org_id = $1', [org.id]);
    expect(status.rows[0].verdict).toBe('flagged');

    // flagged NO bloquea el acceso del tenant (solo suspended lo hace).
    const getProfile = await app.inject({
      method: 'GET',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(getProfile.statusCode).toBe(200);
  });

  it('RFC en 69-B "Desvirtuado": el SAT ya confirmó que salió de la situación de riesgo -> clear', async () => {
    await seedNegativeListEntry(db, 'DSV050505IJ5', 'Desvirtuado');
    const owner = await registerAndLogin(app, 'kyc-desvirtuado-owner@example.com');
    const org = await createOrgFor(app, owner, 'Empresa Desvirtuada', 'kyc-desvirtuado-org');

    const put = await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { legalName: 'Empresa Desvirtuada SA de CV', taxId: 'DSV050505IJ5' },
    });
    expect(put.statusCode).toBe(200);

    const status = await db.query<{ verdict: string }>('select verdict from tenant_kyc_status where org_id = $1', [org.id]);
    expect(status.rows[0].verdict).toBe('clear');
  });

  it('viewer no puede editar el perfil de empresa -- el veredicto de KYC nunca se evalúa antes de la autorización de rol', async () => {
    await seedNegativeListEntry(db, 'VWR060606KL6', 'Definitivo');
    const owner = await registerAndLogin(app, 'kyc-viewer-owner@example.com');
    const org = await createOrgFor(app, owner, 'Empresa Viewer', 'kyc-viewer-org');
    const viewer = await registerAndLogin(app, 'kyc-viewer-member@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const put = await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { legalName: 'Intento de viewer', taxId: 'VWR060606KL6' },
    });
    expect(put.statusCode).toBe(403);
    expect(put.json().type).not.toBe('https://atiende.example/errors/kyc-suspended');

    const status = await db.query('select 1 from tenant_kyc_status where org_id = $1', [org.id]);
    expect(status.rows).toHaveLength(0);
  });
});
