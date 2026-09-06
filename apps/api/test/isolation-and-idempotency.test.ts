import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

describe('aislamiento entre organizaciones vía API', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('el owner de la organización A recibe 403 al intentar operar sobre la organización B usando X-Org-Id', async () => {
    const ownerA = await registerAndLogin(app, 'iso-owner-a@example.com');
    const ownerB = await registerAndLogin(app, 'iso-owner-b@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Org A', 'iso-org-a');
    const orgB = await createOrgFor(app, ownerB, 'Org B', 'iso-org-b');

    const forged = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgB.id },
      payload: { email: 'x@example.com', role: 'viewer' },
    });
    expect(forged.statusCode).toBe(403);

    // Org B no tiene ninguna invitación creada por el intruso.
    const invites = await db.query('select id from invitations where org_id = $1', [orgB.id]);
    expect(invites.rows.length).toBe(0);

    // orgA sigue intacta y solo la ve su propio owner.
    const listA = await app.inject({
      method: 'GET',
      url: '/organizations',
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
    });
    const idsA = listA.json().map((o: any) => o.id);
    expect(idsA).toContain(orgA.id);
    expect(idsA).not.toContain(orgB.id);
  });

  it('un token de acceso válido pero sin membresía en ninguna organización no puede invitar en la de otro', async () => {
    const ownerA = await registerAndLogin(app, 'iso-owner-a2@example.com');
    const outsider = await registerAndLogin(app, 'iso-outsider@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Org A2', 'iso-org-a2');

    const res = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${outsider.accessToken}`, 'x-org-id': orgA.id },
      payload: { email: 'x2@example.com', role: 'viewer' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('idempotencia (Idempotency-Key en POST)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('misma clave + mismo cuerpo -> misma respuesta, sin duplicar la fila creada', async () => {
    const owner = await registerAndLogin(app, 'idem-owner@example.com');
    const org = await createOrgFor(app, owner, 'Idem Org', 'idem-org');
    const key = 'invite-key-1';
    const payload = { email: 'idem-invitee@example.com', role: 'viewer' };

    const first = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'idempotency-key': key },
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());

    const rows = await db.query('select id from invitations where org_id = $1 and email = $2', [
      org.id,
      payload.email,
    ]);
    expect(rows.rows.length).toBe(1);
  });

  it('misma clave + cuerpo distinto -> 422', async () => {
    const owner = await registerAndLogin(app, 'idem-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Idem Org 2', 'idem-org-2');
    const key = 'invite-key-2';

    const first = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'idempotency-key': key },
      payload: { email: 'a@example.com', role: 'viewer' },
    });
    expect(first.statusCode).toBe(201);

    const conflict = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'idempotency-key': key },
      payload: { email: 'b@example.com', role: 'writer' },
    });
    expect(conflict.statusCode).toBe(422);
  });
});
