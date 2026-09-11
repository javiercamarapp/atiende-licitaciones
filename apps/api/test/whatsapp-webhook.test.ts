import { createHmac, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { CaptureProvider } from '@atiende/whatsapp';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';
import { encodeGoPayload, encodeNoGoPayload, encodeNoGoReasonRowId } from '../src/lib/whatsapp/decision-payload.js';
import { NO_GO_REASONS } from '../src/lib/whatsapp/reason-catalog.js';

/**
 * REQ-090 (WhatsApp interfaz de trabajo primaria: decide vía botones/listas,
 * nunca edita matriz/propuesta) + REQ-074 (idempotencia por wamid) + REQ-080
 * (límites de contenido, cubierto a nivel de paquete en
 * packages/whatsapp/test) + REQ-097 (red-teaming de payloads no confiables).
 *
 * Todo lo de aquí entra sin autenticar desde Internet -- cada caso
 * adversarial comprueba no solo el status, sino que NO haya efecto de
 * negocio (mismo criterio que test/mail-webhook.test.ts).
 */
const APP_SECRET = 'app-secret-de-prueba-para-whatsapp-0123456789';
const VERIFY_TOKEN = 'verify-token-de-prueba';

function firmar(rawBody: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

function envelope(messages: unknown[]): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '525500000000', phone_number_id: '1' },
              messages,
            },
          },
        ],
      },
    ],
  });
}

function buttonTap(fromDigits: string, payload: string, wamid = `wamid.${randomUUID()}`): string {
  return envelope([{ id: wamid, from: fromDigits, timestamp: String(Math.floor(Date.now() / 1000)), type: 'button', button: { payload, text: 'x' } }]);
}

function listReply(fromDigits: string, rowId: string, wamid = `wamid.${randomUUID()}`): string {
  return envelope([
    {
      id: wamid,
      from: fromDigits,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: rowId, title: 'x' } },
    },
  ]);
}

describe('REQ-090/074/080/097: webhook interactivo de WhatsApp (decisión Go/No-Go)', () => {
  let app: FastifyInstance;
  let db: DbClient;
  let capture: CaptureProvider;

  beforeEach(async () => {
    capture = new CaptureProvider();
    ({ app, db } = await createTestApp(
      { whatsappWebhookAppSecret: APP_SECRET, whatsappWebhookVerifyToken: VERIFY_TOKEN },
      { whatsappProvider: capture }
    ));
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function seedTender(orgId: string, externalId: string): Promise<string> {
    const id = randomUUID();
    await db.query(`insert into tenders (id, org_id, source, external_id, title) values ($1, $2, 'test', $3, 'Convocatoria de prueba')`, [
      id,
      orgId,
      externalId,
    ]);
    return id;
  }

  async function setPhone(userId: string, phoneE164: string): Promise<void> {
    await db.query('update users set whatsapp_phone_e164 = $1 where id = $2', [phoneE164, userId]);
  }

  async function decisions(tenderId: string): Promise<Array<{ decision: string; reasons: string[] }>> {
    const { rows } = await db.query<{ decision: string; reasons: string[] }>(
      'select decision, reasons from go_no_go_decisions where tender_id = $1 order by decided_at asc',
      [tenderId]
    );
    return rows;
  }

  async function ignoredEvents(): Promise<Array<{ after: { reason?: string } }>> {
    const { rows } = await db.query<{ after: { reason?: string } }>("select after from audit_log where entity = 'whatsapp_webhook'");
    return rows;
  }

  function entregar(rawBody: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(rawBody), ...headers },
      payload: rawBody,
    });
  }

  describe('handshake de suscripción (GET)', () => {
    it('verify_token correcto -> 200 con el challenge en texto plano', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('12345');
    });

    it('ADVERSARIAL: verify_token incorrecto -> 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=adivinado&hub.challenge=12345`,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  it('tocar "Go" persiste go_no_go_decisions(decision=go) y confirma por WhatsApp', async () => {
    const owner = await registerAndLogin(app, 'wa-go-owner@example.com');
    const org = await createOrgFor(app, owner, 'WA Go Org', 'wa-go-org');
    const tenderId = await seedTender(org.id, 'wa-go-1');
    await setPhone(owner.id, '+525511110001');

    const res = await entregar(buttonTap('525511110001', encodeGoPayload(tenderId)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 1 });

    expect(await decisions(tenderId)).toEqual([{ decision: 'go', reasons: [] }]);
    expect(capture.findLastTextTo('+525511110001')?.body).toContain('Go');
  });

  it('tocar "No-Go" NO persiste nada todavía -- responde con una lista interactiva de motivos (REQ-090: listas)', async () => {
    const owner = await registerAndLogin(app, 'wa-nogo-ask-owner@example.com');
    const org = await createOrgFor(app, owner, 'WA NoGo Ask Org', 'wa-nogo-ask-org');
    const tenderId = await seedTender(org.id, 'wa-nogo-ask-1');
    await setPhone(owner.id, '+525511110002');

    const res = await entregar(buttonTap('525511110002', encodeNoGoPayload(tenderId)));
    expect(res.statusCode).toBe(200);

    expect(await decisions(tenderId)).toEqual([]);
    const list = capture.findLastInteractiveListTo('+525511110002');
    expect(list).toBeDefined();
    expect(list!.sections[0]!.rows.length).toBe(NO_GO_REASONS.length);
    expect(list!.sections[0]!.rows.map((r) => r.id)).toContain(encodeNoGoReasonRowId(tenderId, 'plazo_insuficiente'));
  });

  it('elegir una fila de motivo persiste go_no_go_decisions(decision=no_go, reasons=[motivo completo])', async () => {
    const owner = await registerAndLogin(app, 'wa-nogo-reason-owner@example.com');
    const org = await createOrgFor(app, owner, 'WA NoGo Reason Org', 'wa-nogo-reason-org');
    const tenderId = await seedTender(org.id, 'wa-nogo-reason-1');
    await setPhone(owner.id, '+525511110003');

    const rowId = encodeNoGoReasonRowId(tenderId, 'plazo_insuficiente');
    const res = await entregar(listReply('525511110003', rowId));
    expect(res.statusCode).toBe(200);

    const rows = await decisions(tenderId);
    expect(rows).toEqual([{ decision: 'no_go', reasons: ['Plazo insuficiente para preparar una propuesta de calidad'] }]);
    expect(capture.findLastTextTo('+525511110003')?.body).toContain('No-Go');
  });

  it('ADVERSARIAL (REQ-074): reenviar la MISMA entrega (mismo wamid) es un no-op -- no se duplica la decisión', async () => {
    const owner = await registerAndLogin(app, 'wa-replay-owner@example.com');
    const org = await createOrgFor(app, owner, 'WA Replay Org', 'wa-replay-org');
    const tenderId = await seedTender(org.id, 'wa-replay-1');
    await setPhone(owner.id, '+525511110004');

    const wamid = `wamid.${randomUUID()}`;
    const raw = buttonTap('525511110004', encodeGoPayload(tenderId), wamid);

    const first = await entregar(raw);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ processed: 1 });
    expect(await decisions(tenderId)).toHaveLength(1);

    const replay = await entregar(raw);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ processed: 0 });
    expect(await decisions(tenderId)).toHaveLength(1);
  });

  it('ADVERSARIAL: rol insuficiente (writer) -> se ignora, NINGÚN efecto, rastro en audit_log', async () => {
    const owner = await registerAndLogin(app, 'wa-writer-owner@example.com');
    const org = await createOrgFor(app, owner, 'WA Writer Org', 'wa-writer-org');
    const tenderId = await seedTender(org.id, 'wa-writer-1');

    const writer = await registerAndLogin(app, 'wa-writer-user@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);
    await setPhone(writer.id, '+525511110005');

    const res = await entregar(buttonTap('525511110005', encodeGoPayload(tenderId)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 1 }); // el evento se PROCESA (no es replay); el efecto de negocio se ignora dentro.

    expect(await decisions(tenderId)).toEqual([]);
    const ignored = await ignoredEvents();
    expect(ignored.some((e) => e.after.reason === 'role_not_allowed')).toBe(true);
  });

  it('ADVERSARIAL: número sin vincular a ningún usuario -> se ignora, ningún efecto', async () => {
    const owner = await registerAndLogin(app, 'wa-unlinked-owner@example.com');
    const org = await createOrgFor(app, owner, 'WA Unlinked Org', 'wa-unlinked-org');
    const tenderId = await seedTender(org.id, 'wa-unlinked-1');

    const res = await entregar(buttonTap('525599990000', encodeGoPayload(tenderId)));
    expect(res.statusCode).toBe(200);
    expect(await decisions(tenderId)).toEqual([]);
    const ignored = await ignoredEvents();
    expect(ignored.some((e) => e.after.reason === 'phone_not_linked')).toBe(true);
  });

  it('ADVERSARIAL: usuario real pero SIN membresía en la organización dueña del tender -> se ignora (no cruza organizaciones)', async () => {
    const ownerA = await registerAndLogin(app, 'wa-crossorg-a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'WA CrossOrg A', 'wa-crossorg-a');
    const tenderId = await seedTender(orgA.id, 'wa-crossorg-1');

    const outsider = await registerAndLogin(app, 'wa-crossorg-b@example.com');
    await createOrgFor(app, outsider, 'WA CrossOrg B', 'wa-crossorg-b'); // dueño de OTRA organización, no de orgA
    await setPhone(outsider.id, '+525511110006');

    const res = await entregar(buttonTap('525511110006', encodeGoPayload(tenderId)));
    expect(res.statusCode).toBe(200);
    expect(await decisions(tenderId)).toEqual([]);
    const ignored = await ignoredEvents();
    expect(ignored.some((e) => e.after.reason === 'not_a_member')).toBe(true);
  });

  it('un replyId no reconocido (forjado o de una versión anterior) se ignora sin lanzar', async () => {
    const owner = await registerAndLogin(app, 'wa-garbage-owner@example.com');
    await setPhone(owner.id, '+525511110007');

    const res = await entregar(buttonTap('525511110007', 'ALGO_QUE_NO_EXISTE:no-es-un-uuid'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 1 });
  });

  it('un tenderId con formato de UUID pero inexistente se ignora (tender_not_found), sin lanzar', async () => {
    const owner = await registerAndLogin(app, 'wa-notender-owner@example.com');
    await setPhone(owner.id, '+525511110008');

    const res = await entregar(buttonTap('525511110008', encodeGoPayload(randomUUID())));
    expect(res.statusCode).toBe(200);
    const ignored = await ignoredEvents();
    expect(ignored.some((e) => e.after.reason === 'tender_not_found')).toBe(true);
  });

  describe('ADVERSARIAL: firma', () => {
    it('firmado con OTRO secreto (forjado) -> 401 y ningún efecto', async () => {
      const owner = await registerAndLogin(app, 'wa-forged-owner@example.com');
      const org = await createOrgFor(app, owner, 'WA Forged Org', 'wa-forged-org');
      const tenderId = await seedTender(org.id, 'wa-forged-1');
      await setPhone(owner.id, '+525511110009');

      const raw = buttonTap('525511110009', encodeGoPayload(tenderId));
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(raw, 'secreto-del-atacante') },
        payload: raw,
      });
      expect(res.statusCode).toBe(401);
      expect(await decisions(tenderId)).toEqual([]);
    });

    it('cuerpo alterado DESPUÉS de firmar -> 401 y ningún efecto', async () => {
      const owner = await registerAndLogin(app, 'wa-tampered-owner@example.com');
      const org = await createOrgFor(app, owner, 'WA Tampered Org', 'wa-tampered-org');
      const tenderId = await seedTender(org.id, 'wa-tampered-1');
      await setPhone(owner.id, '+525511110010');

      const original = buttonTap('525511110010', encodeNoGoPayload(tenderId));
      const alterado = buttonTap('525511110010', encodeGoPayload(tenderId));
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(original) },
        payload: alterado,
      });
      expect(res.statusCode).toBe(401);
      expect(await decisions(tenderId)).toEqual([]);
    });

    it('sin cabecera de firma -> 401', async () => {
      const raw = buttonTap('525500000000', 'GO:x');
      const res = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json' }, payload: raw });
      expect(res.statusCode).toBe(401);
    });
  });

  it('SIN WHATSAPP_WEBHOOK_APP_SECRET configurado -> 503 y NUNCA procesa nada (falla cerrado)', async () => {
    const sinSecreto = await createTestApp({ whatsappWebhookAppSecret: undefined }, { whatsappProvider: new CaptureProvider() });
    try {
      const raw = buttonTap('525500000000', 'GO:x');
      const res = await sinSecreto.app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(raw) },
        payload: raw,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await sinSecreto.app.close();
      await sinSecreto.db.close();
    }
  });

  it('un payload deforme (JSON inválido) con firma válida sobre ese cuerpo se acepta y no produce eventos, sin lanzar', async () => {
    const raw = 'esto no es json';
    const res = await entregar(raw);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 0 });
  });
});
