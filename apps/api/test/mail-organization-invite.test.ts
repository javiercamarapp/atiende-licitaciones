import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';
import { allMail, lastMailTo, urlFrom } from './helpers/mail.js';

/**
 * S5 / REQ-186 (docs/ACEPTACION.md): "correo de invitación con enlace
 * firmado expira y es rechazado tras vencer". La invitación a una
 * organización ahora LLEGA POR CORREO, con el mismo token que la respuesta
 * de la API ya devolvía, envuelto en un enlace firmado con expiración; y
 * `POST /organizations/invitations/accept` acepta ese enlace (`d`/`s`)
 * verificando firma y vencimiento EN EL SERVIDOR.
 *
 * Lo que se prueba aquí y no en `auth-and-orgs-flow.test.ts` (que cubre el
 * flujo de membresías en sí): que el correo sale, que el enlace es firmado y
 * apunta a `apps/web`, que el enlace ACEPTA la invitación de verdad, que un
 * enlace vencido o alterado se rechaza, y que un reintento idempotente no
 * manda dos correos.
 */
describe('S5/REQ-186: invitación a organización por correo', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function ownerConOrg() {
    const owner = await registerAndLogin(app, 'inv-owner@example.com');
    const org = await createOrgFor(app, owner, 'Constructora del Norte', 'constructora-norte');
    return { owner, org };
  }

  function invitar(owner: { accessToken: string }, orgId: string, email: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': orgId, ...headers },
      payload: { email, role: 'analyst' },
    });
  }

  it('invitar manda el correo al invitado con un enlace FIRMADO cuyo token acepta la invitación de verdad', async () => {
    const { owner, org } = await ownerConOrg();
    const res = await invitar(owner, org.id, 'invitada@example.com');
    expect(res.statusCode).toBe(201);

    const correo = await lastMailTo(app, 'invitada@example.com');
    expect(correo.to).toEqual(['invitada@example.com']);
    // El nombre real de la organización y de quien invita van en el cuerpo.
    expect(correo.html).toContain('Constructora del Norte');

    const url = urlFrom(correo, '/invitaciones/aceptar');
    expect(url.origin).toBe(new URL(app.config.publicUrl).origin);
    const payload = JSON.parse(Buffer.from(url.searchParams.get('d')!, 'base64url').toString('utf8')) as {
      invitationId: string;
      token: string;
      exp: number;
    };
    expect(payload.invitationId).toBe(res.json().id);
    // El TTL del enlace coincide con el de `invitations.expires_at` (7 días):
    // la firma nunca sobrevive a la invitación ni al revés.
    const diasDeVida = (payload.exp - Math.floor(Date.now() / 1000)) / 86400;
    expect(diasDeVida).toBeGreaterThan(6.9);
    expect(diasDeVida).toBeLessThan(7.1);

    // El token del ENLACE (no el de la respuesta HTTP) es el que sirve.
    const invitada = await registerAndLogin(app, 'invitada@example.com');
    const accept = await app.inject({
      method: 'POST',
      url: '/organizations/invitations/accept',
      headers: { authorization: `Bearer ${invitada.accessToken}` },
      payload: { token: payload.token },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toMatchObject({ orgId: org.id, role: 'analyst' });
  });

  it('S5: el enlace del correo acepta la invitación tal cual (d/s), y VENCIDO o ALTERADO se rechaza en el servidor', async () => {
    const { owner, org } = await ownerConOrg();
    const res = await invitar(owner, org.id, 'enlace@example.com');
    const url = urlFrom(await lastMailTo(app, 'enlace@example.com'), '/invitaciones/aceptar');
    const d = url.searchParams.get('d')!;
    const s = url.searchParams.get('s')!;
    const { token } = JSON.parse(Buffer.from(d, 'base64url').toString('utf8')) as { token: string };

    const invitada = await registerAndLogin(app, 'enlace@example.com');
    const headers = { authorization: `Bearer ${invitada.accessToken}` };

    // Firma alterada: rechazada ANTES de tocar `app.accept_invitation`.
    const alterado = await app.inject({
      method: 'POST',
      url: '/organizations/invitations/accept',
      headers,
      payload: { d, s: `${s.slice(0, -2)}AA` },
    });
    expect(alterado.statusCode).toBe(400);

    // Enlace VENCIDO: mismo token real, firmado por el mismo servicio, con
    // TTL negativo -- aísla la expiración como única variable.
    const vencidoUrl = new URL(
      app.mail.signedLink(app.config.publicUrl, '/invitaciones/aceptar', { invitationId: res.json().id, token }, -60)
    );
    const vencido = await app.inject({
      method: 'POST',
      url: '/organizations/invitations/accept',
      headers,
      payload: { d: vencidoUrl.searchParams.get('d')!, s: vencidoUrl.searchParams.get('s')! },
    });
    expect(vencido.statusCode).toBe(400);
    expect(vencido.json().title).toBe(alterado.json().title); // mismo mensaje, sin distinguir el motivo

    // Ninguno de los dos intentos concedió membresía.
    const sinMembresia = await db.query<{ id: string }>('select id from memberships where user_id = $1', [invitada.id]);
    expect(sinMembresia.rows.length).toBe(0);

    // El enlace ÍNTEGRO y vigente sí funciona.
    const ok = await app.inject({ method: 'POST', url: '/organizations/invitations/accept', headers, payload: { d, s } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ orgId: org.id, role: 'analyst' });
  });

  it('S5: una invitación VENCIDA en base se rechaza aunque el enlace firmado siga vigente', async () => {
    const { owner, org } = await ownerConOrg();
    const res = await invitar(owner, org.id, 'caducada@example.com');
    const url = urlFrom(await lastMailTo(app, 'caducada@example.com'), '/invitaciones/aceptar');

    // La invitación caduca en base (7 días) con independencia del TTL del
    // enlace: se fuerza el vencimiento para comprobar que la segunda barrera
    // también existe.
    await db.query("update invitations set expires_at = now() - interval '1 day' where id = $1", [res.json().id]);

    const invitada = await registerAndLogin(app, 'caducada@example.com');
    const intento = await app.inject({
      method: 'POST',
      url: '/organizations/invitations/accept',
      headers: { authorization: `Bearer ${invitada.accessToken}` },
      payload: { d: url.searchParams.get('d')!, s: url.searchParams.get('s')! },
    });
    expect(intento.statusCode).toBeGreaterThanOrEqual(400);

    const sinMembresia = await db.query<{ id: string }>('select id from memberships where user_id = $1', [invitada.id]);
    expect(sinMembresia.rows.length).toBe(0);
  });

  it('el token en claro NO se persiste: en `invitations` solo vive su hash', async () => {
    const { owner, org } = await ownerConOrg();
    const res = await invitar(owner, org.id, 'hash@example.com');
    const url = urlFrom(await lastMailTo(app, 'hash@example.com'), '/invitaciones/aceptar');
    const { token } = JSON.parse(Buffer.from(url.searchParams.get('d')!, 'base64url').toString('utf8')) as { token: string };

    const { rows } = await db.query<{ token_hash: string }>('select token_hash from invitations where id = $1', [res.json().id]);
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toHaveLength(64);
  });

  it('un reintento con la MISMA Idempotency-Key no manda un segundo correo', async () => {
    const { owner, org } = await ownerConOrg();
    const headers = { 'idempotency-key': 'invitacion-repetida-1' };

    const primera = await invitar(owner, org.id, 'idem@example.com', headers);
    expect(primera.statusCode).toBe(201);
    await app.waitForPendingMail();
    const tras1 = (await allMail(app)).filter((c) => c.to.includes('idem@example.com')).length;
    expect(tras1).toBe(1);

    const segunda = await invitar(owner, org.id, 'idem@example.com', headers);
    expect(segunda.json().id).toBe(primera.json().id);
    await app.waitForPendingMail();
    // MailService es idempotente por `messageKey` (`organization-invite:<id>`):
    // el segundo intento resuelve `already_sent` sin tocar el proveedor.
    expect((await allMail(app)).filter((c) => c.to.includes('idem@example.com')).length).toBe(1);
  });

  it('ADVERSARIAL: el token de la invitación es de un solo uso y solo sirve para el correo invitado', async () => {
    const { owner, org } = await ownerConOrg();
    await invitar(owner, org.id, 'unica@example.com');
    const url = urlFrom(await lastMailTo(app, 'unica@example.com'), '/invitaciones/aceptar');
    const { token } = JSON.parse(Buffer.from(url.searchParams.get('d')!, 'base64url').toString('utf8')) as { token: string };

    // Otra persona (correo distinto) con el token interceptado: rechazado.
    const intrusa = await registerAndLogin(app, 'intrusa@example.com');
    const robo = await app.inject({
      method: 'POST',
      url: '/organizations/invitations/accept',
      headers: { authorization: `Bearer ${intrusa.accessToken}` },
      payload: { token },
    });
    expect(robo.statusCode).toBeGreaterThanOrEqual(400);

    // La destinataria legítima sí puede, y solo una vez.
    const invitada = await registerAndLogin(app, 'unica@example.com');
    const headers = { authorization: `Bearer ${invitada.accessToken}` };
    expect((await app.inject({ method: 'POST', url: '/organizations/invitations/accept', headers, payload: { token } })).statusCode).toBe(200);
    const repetida = await app.inject({ method: 'POST', url: '/organizations/invitations/accept', headers, payload: { token } });
    expect(repetida.statusCode).toBeGreaterThanOrEqual(400);
  });
});
