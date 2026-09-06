import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * E8/E9 — `PackageAssembler` real (ZIP en disco + manifiesto) y
 * `submissions` (declaración del usuario, A15). Cobertura: A13 (expediente
 * completo descargable con manifiesto real), A14 (incompleto nunca
 * "listo"), A15 (ningún cliente HTTP saliente en el módulo de submission).
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'pkg-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Servicio de mensajería', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — paquete final y presentación declarada (E8/E9)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('A14: expediente incompleto (sin checklist verde ni aprobación) nunca ensambla "ready", siempre "draft" con motivos explícitos', async () => {
    const owner = await registerAndLogin(app, 'pkg-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Pkg Org 1', 'pkg-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });

    const assemble = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(assemble.statusCode).toBe(200);
    expect(assemble.json().status).toBe('draft');
    expect(assemble.json().draftReasons.length).toBeGreaterThan(0);
    expect(assemble.json().notice).toContain('presentación y firma las realiza el usuario');

    const download = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/package/download`, headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');

    const zip = await JSZip.loadAsync(download.rawPayload);
    const manifestFile = Object.keys(zip.files).find((f) => f.includes('manifiesto.json'));
    expect(manifestFile).toBeDefined();
    const manifest = JSON.parse(await zip.files[manifestFile!].async('string'));
    expect(manifest.status).toBe('draft');
    expect(manifest.watermark).toBe('BORRADOR');
    expect(Object.keys(zip.files).some((f) => f.includes('BORRADOR'))).toBe(true);
  });

  it('A13: expediente completo (checklist verde real + aprobación vigente con hash coincidente) ensambla "ready" y el ZIP se relee con el manifiesto correcto', async () => {
    const owner = await registerAndLogin(app, 'pkg-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Pkg Org 2', 'pkg-org-2');
    const tenderId = await createTender(app, org.id, 'pkg-002');
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };

    // Datos de empresa reales + tarifa aprobada, para que el cálculo
    // económico resuelva realmente (dimensión "calculos_economicos" verde).
    await app.inject({ method: 'PUT', url: '/company/profile', headers, payload: { legalName: 'Mensajería Rápida SA de CV', taxId: 'MRA010101AAA' } });
    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'envio-local', description: 'Envío local', unitPrice: 120, validFrom: '2020-01-01' } });
    await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers });

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });
    const economic = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'envio-local', quantity: 5 }] },
    });
    expect(economic.json().economicTotals).not.toBeNull();

    // Checklist verde: sin archivos que violen límites/formatos, sin
    // documentos usados que validar (ninguno referenciado en esta
    // propuesta técnica), sin firmas pendientes, sin anexos obligatorios
    // (no se corrió build de matriz -> 0 requisitos "anexo"), y
    // consistencia cruzada real (carta/anexo, mismo total, dos fuentes
    // independientes) -- ver checklist.routes.ts.
    const checklist = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/checklist/run`,
      headers,
      payload: { files: [], formatLimits: { allowedExtensions: ['pdf'], maxFileSizeBytes: 5_000_000, maxUploadSlots: 5 }, requiredSignatures: [] },
    });
    expect(checklist.json().overallStatus).toBe('verde');

    const approve = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/approve`, headers, payload: { scope: 'expediente', scopeRef: 'expediente' } });
    expect(approve.json().fullyApproved).toBe(true);

    const assemble = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(assemble.statusCode).toBe(200);
    expect(assemble.json().status).toBe('ready');
    expect(assemble.json().draftReasons).toEqual([]);

    const download = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/package/download`, headers });
    expect(download.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(download.rawPayload);
    const manifestFile = Object.keys(zip.files).find((f) => f.endsWith('manifiesto.json'));
    const manifest = JSON.parse(await zip.files[manifestFile!].async('string'));
    expect(manifest.status).toBe('ready');
    expect(manifest.watermark).toBeNull();
    expect(manifest.notice).toContain('el sistema no envía ofertas');

    const dbRow = await db.query('select storage_ref, status from package_manifests where org_id = $1 order by generated_at desc limit 1', [org.id]);
    expect(dbRow.rows[0].status).toBe('ready');
    expect(readFileSync(`${app.config.storageDir}/${dbRow.rows[0].storage_ref}`).length).toBeGreaterThan(0);
  });

  it('A15: submissions solo registra la declaración del usuario (fecha + acuse subido); nunca envía nada, y el módulo no importa ningún cliente HTTP saliente', async () => {
    const owner = await registerAndLogin(app, 'pkg-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Pkg Org 3', 'pkg-org-3');
    const tenderId = await createTender(app, org.id, 'pkg-003');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });

    const before = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/submission`, headers });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toBeNull();

    const acknowledgementBase64 = Buffer.from('Acuse de recibo firmado por el usuario, subido manualmente.').toString('base64');
    const declare = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/submission/declare`,
      headers,
      payload: { submittedAt: new Date().toISOString(), acknowledgementFilename: 'acuse.txt', acknowledgementContentBase64: acknowledgementBase64, notes: 'Presentado en el portal por mí mismo.' },
    });
    expect(declare.statusCode).toBe(201);
    expect(declare.json().status).toBe('submitted');
    expect(declare.json().acknowledgementStorageRef).toBeTruthy();

    const after = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/submission`, headers });
    expect(after.json().status).toBe('submitted');

    // Verificación estática (A15): ningún import de cliente HTTP saliente
    // en el módulo de submission -- el usuario es quien presenta, nunca el
    // sistema (mismo patrón que packages/expediente/test/api-surface.test.ts).
    const source = readFileSync(new URL('../src/modules/expediente/submission.routes.ts', import.meta.url), 'utf8');
    const codeOnly = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n');
    for (const forbidden of [/from\s+['"]node:https?['"]/, /from\s+['"]https?['"]/, /from\s+['"]undici['"]/, /from\s+['"]node-fetch['"]/, /from\s+['"]axios['"]/, /\brequire\(\s*['"]https?['"]\s*\)/]) {
      expect(codeOnly).not.toMatch(forbidden);
    }
  });
});
