import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * REQ-060: módulo de lado comprador (OIC/contraloría), a nivel HTTP.
 * La garantía REAL de aislamiento vive en RLS (ver
 * packages/db/test/req060-oic-isolation.test.ts); esta suite verifica que
 * la capa de aplicación (`requireOicOrg`/`requireOicRole`, cabecera
 * `X-Oic-Org-Id` separada de `X-Org-Id`) funciona de punta a punta y no
 * abre ningún atajo que RLS tuviera que tapar.
 */
async function createOicOrgFor(
  app: FastifyInstance,
  accessToken: string,
  name: string,
  slug: string
): Promise<{ id: string; name: string; slug: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/oic/organizations',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name, slug },
  });
  if (res.statusCode !== 201) {
    throw new Error(`create oic org failed: ${res.statusCode} ${res.body}`);
  }
  return res.json();
}

describe('REQ-060: módulo comprador (OIC) -- HTTP', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    // Esta suite registra/inicia sesión con MUCHOS usuarios distintos (una
    // organización compradora Y una proveedora por caso, en varios casos) --
    // el perfil de límite de tasa `default` de /auth/login agota su cupo
    // mucho antes de terminar. `e2e` relaja esos límites SIN afectar los
    // tiers que nunca se relajan (2FA, ver rate-limit-settings.ts).
    ({ app, db } = await createTestApp({ rateLimitProfile: 'e2e' }));
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('un usuario autenticado crea una organización compradora y queda como director_oic', async () => {
    const user = await registerAndLogin(app, 'director-http@example.com');
    const org = await createOicOrgFor(app, user.accessToken, 'Contraloría Uno', 'contraloria-uno');
    expect(org.name).toBe('Contraloría Uno');

    const mine = await app.inject({
      method: 'GET',
      url: '/oic/organizations',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: org.id, role: 'director_oic' })])
    );
  });

  it('CRUD completo de procedimientos vigilados (watch-items) para director_oic', async () => {
    const user = await registerAndLogin(app, 'director-watch@example.com');
    const org = await createOicOrgFor(app, user.accessToken, 'Contraloría Watch', 'contraloria-watch');
    const headers = { authorization: `Bearer ${user.accessToken}`, 'x-oic-org-id': org.id };

    const created = await app.inject({
      method: 'POST',
      url: '/oic/watch-items',
      headers,
      payload: { source: 'comprasmx', externalId: 'EXT-HTTP-1', title: 'Procedimiento HTTP', contractingBody: 'Dependencia X' },
    });
    expect(created.statusCode).toBe(201);
    const item = created.json();
    expect(item.status).toBe('abierto');
    expect(item.riskCategory).toBe('sin_clasificar');

    const list = await app.inject({ method: 'GET', url: '/oic/watch-items', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((i: any) => i.id)).toContain(item.id);

    const got = await app.inject({ method: 'GET', url: `/oic/watch-items/${item.id}`, headers });
    expect(got.statusCode).toBe(200);
    expect(got.json().id).toBe(item.id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/oic/watch-items/${item.id}`,
      headers,
      payload: { riskCategory: 'plazo_corto', status: 'en_revision', riskNote: 'Riesgo estadístico, no acusación.' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ riskCategory: 'plazo_corto', status: 'en_revision' });
  });

  it('rechaza un source/externalId duplicado en la misma organización (409)', async () => {
    const user = await registerAndLogin(app, 'director-dup@example.com');
    const org = await createOicOrgFor(app, user.accessToken, 'Contraloría Dup', 'contraloria-dup');
    const headers = { authorization: `Bearer ${user.accessToken}`, 'x-oic-org-id': org.id };
    const payload = { source: 'comprasmx', externalId: 'EXT-DUP', title: 'x' };

    const first = await app.inject({ method: 'POST', url: '/oic/watch-items', headers, payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/oic/watch-items', headers, payload });
    expect(second.statusCode).toBe(409);
  });

  it('consulta_oic puede leer pero no crear/editar watch-items (403 de aplicación, antes de tocar RLS)', async () => {
    const director = await registerAndLogin(app, 'director-roles@example.com');
    const org = await createOicOrgFor(app, director.accessToken, 'Contraloría Roles', 'contraloria-roles');

    const consulta = await registerAndLogin(app, 'consulta-roles@example.com');
    const addMember = await app.inject({
      method: 'POST',
      url: '/oic/organizations/members',
      headers: { authorization: `Bearer ${director.accessToken}`, 'x-oic-org-id': org.id },
      payload: { userId: consulta.id, role: 'consulta_oic' },
    });
    expect(addMember.statusCode).toBe(201);

    const consultaHeaders = { authorization: `Bearer ${consulta.accessToken}`, 'x-oic-org-id': org.id };
    const forbidden = await app.inject({
      method: 'POST',
      url: '/oic/watch-items',
      headers: consultaHeaders,
      payload: { source: 'comprasmx', externalId: 'EXT-RO-HTTP', title: 'x' },
    });
    expect(forbidden.statusCode).toBe(403);

    const listOk = await app.inject({ method: 'GET', url: '/oic/watch-items', headers: consultaHeaders });
    expect(listOk.statusCode).toBe(200);
  });

  it('analista_oic no puede dar de alta miembros (solo director_oic)', async () => {
    const director = await registerAndLogin(app, 'director-noadmin@example.com');
    const org = await createOicOrgFor(app, director.accessToken, 'Contraloría NoAdmin', 'contraloria-noadmin');

    const analista = await registerAndLogin(app, 'analista-noadmin@example.com');
    await app.inject({
      method: 'POST',
      url: '/oic/organizations/members',
      headers: { authorization: `Bearer ${director.accessToken}`, 'x-oic-org-id': org.id },
      payload: { userId: analista.id, role: 'analista_oic' },
    });

    const tercero = await registerAndLogin(app, 'tercero-noadmin@example.com');
    const forbidden = await app.inject({
      method: 'POST',
      url: '/oic/organizations/members',
      headers: { authorization: `Bearer ${analista.accessToken}`, 'x-oic-org-id': org.id },
      payload: { userId: tercero.id, role: 'consulta_oic' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  describe('aislamiento entre lado comprador y lado proveedor a nivel HTTP', () => {
    it('X-Oic-Org-Id apuntando a una organización PROVEEDORA es rechazado (403), nunca resuelve datos', async () => {
      const supplierUser = await registerAndLogin(app, 'proveedor-http@example.com');
      const supplierOrg = await createOrgFor(app, supplierUser, 'Proveedor HTTP', 'proveedor-http');

      const attempt = await app.inject({
        method: 'GET',
        url: '/oic/watch-items',
        headers: { authorization: `Bearer ${supplierUser.accessToken}`, 'x-oic-org-id': supplierOrg.id },
      });
      expect(attempt.statusCode).toBe(403);
    });

    it('X-Org-Id (proveedor) apuntando a una organización COMPRADORA es rechazado (403), nunca resuelve rol', async () => {
      const oicUser = await registerAndLogin(app, 'oic-como-proveedor@example.com');
      const oicOrg = await createOicOrgFor(app, oicUser.accessToken, 'Contraloría Cruzada', 'contraloria-cruzada');

      const attempt = await app.inject({
        method: 'GET',
        url: '/audit-log',
        headers: { authorization: `Bearer ${oicUser.accessToken}`, 'x-org-id': oicOrg.id },
      });
      expect(attempt.statusCode).toBe(403);
    });

    it('un usuario "de doble vida" no puede leer los watch-items de su organización OIC usando el flujo de proveedor, ni viceversa', async () => {
      const dual = await registerAndLogin(app, 'doble-vida-http@example.com');
      const supplierOrg = await createOrgFor(app, dual, 'Proveedor Doble Vida', 'proveedor-doble-vida-http');
      const oicOrg = await createOicOrgFor(app, dual.accessToken, 'Contraloría Doble Vida', 'contraloria-doble-vida-http');

      const created = await app.inject({
        method: 'POST',
        url: '/oic/watch-items',
        headers: { authorization: `Bearer ${dual.accessToken}`, 'x-oic-org-id': oicOrg.id },
        payload: { source: 'comprasmx', externalId: 'EXT-DV-HTTP', title: 'x' },
      });
      expect(created.statusCode).toBe(201);
      const watchItemId = created.json().id;

      // La ruta OIC solo entiende `X-Oic-Org-Id` -- mandar únicamente
      // `X-Org-Id` (el header del lado proveedor) equivale a no mandar
      // ningún header OIC en absoluto: `requireOicOrg` ni siquiera LEE
      // `X-Org-Id`, así que no hay ninguna ruta por la que ese valor pueda
      // colarse como organización activa del lado comprador.
      const crossed = await app.inject({
        method: 'GET',
        url: `/oic/watch-items/${watchItemId}`,
        headers: { authorization: `Bearer ${dual.accessToken}`, 'x-org-id': oicOrg.id },
      });
      expect(crossed.statusCode).toBe(403);

      const missingHeader = await app.inject({
        method: 'GET',
        url: `/oic/watch-items/${watchItemId}`,
        headers: { authorization: `Bearer ${dual.accessToken}` },
      });
      expect(missingHeader.statusCode).toBe(403);

      // Y la organización proveedora del mismo usuario no ve el watch-item
      // (ni siquiera es la ruta correcta -- /tenders es de otro dominio,
      // pero confirma que el organismo comprador es invisible desde ese lado).
      const supplierTenders = await app.inject({
        method: 'GET',
        url: '/tenders',
        headers: { authorization: `Bearer ${dual.accessToken}`, 'x-org-id': supplierOrg.id },
      });
      expect(supplierTenders.statusCode).toBe(200);
      expect(JSON.stringify(supplierTenders.json())).not.toContain(watchItemId);
    });
  });
});
