import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyResendWebhookSignature } from '@atiende/mail';
import { createHmacWebhookGuard } from '../../../src/lib/webhooks/hmac-webhook-guard.js';
import { createSvixScheme } from '../../../src/lib/webhooks/svix-scheme.js';
import { AppError, ConflictError, UnauthorizedError } from '../../../src/lib/errors.js';

/**
 * REQ-096: prueba de EQUIVALENCIA entre `createSvixScheme()` (el adaptador
 * genérico) y `verifyResendWebhookSignature` de `@atiende/mail` (la
 * implementación real y ya en producción de `POST /webhooks/mail/:provider`)
 * — ante las MISMAS cabeceras, cuerpo y secreto, ambos deben aceptar o
 * rechazar exactamente igual. Esto es la evidencia de que generalizar el
 * esquema Svix a `createHmacWebhookGuard` no inventó un comportamiento
 * nuevo: es fiel al que ya usa el webhook de correo real.
 */
const SECRET = `whsec_${Buffer.from('secreto-de-prueba-para-equivalencia-svix').toString('base64')}`;

function sign(svixId: string, svixTimestamp: string, rawBody: string, secret = SECRET): string {
  const base64 = secret.replace(/^whsec_/, '');
  const digest = createHmac('sha256', Buffer.from(base64, 'base64'))
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${digest}`;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba que la promesa fallara, pero resolvió');
}

describe('createSvixScheme — equivalencia con @atiende/mail (verifyResendWebhookSignature)', () => {
  it('ambos ACEPTAN la misma petición válida', async () => {
    const rawBody = JSON.stringify({ type: 'email.bounced' });
    const svixId = `msg_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const headers = { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': sign(svixId, svixTimestamp, rawBody) };

    const mailResult = verifyResendWebhookSignature(
      rawBody,
      { svixId, svixTimestamp, svixSignature: headers['svix-signature'] },
      SECRET,
    );
    expect(mailResult).toEqual({ ok: true });

    const verify = createHmacWebhookGuard({ scheme: createSvixScheme(), getSecret: () => SECRET, notConfiguredMessage: 'x' });
    await expect(verify(rawBody, headers)).resolves.toEqual({ eventId: svixId });
  });

  it('ambos RECHAZAN el cuerpo alterado después de firmar', async () => {
    const rawBody = JSON.stringify({ type: 'email.bounced' });
    const svixId = `msg_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const svixSignature = sign(svixId, svixTimestamp, rawBody);
    const alterado = JSON.stringify({ type: 'email.delivered' });

    const mailResult = verifyResendWebhookSignature(alterado, { svixId, svixTimestamp, svixSignature }, SECRET);
    expect(mailResult).toEqual({ ok: false, reason: 'firma_invalida' });

    const verify = createHmacWebhookGuard({ scheme: createSvixScheme(), getSecret: () => SECRET, notConfiguredMessage: 'x' });
    const err = await captureRejection(verify(alterado, { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': svixSignature }));
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('ambos RECHAZAN un timestamp fuera de la ventana de tolerancia', async () => {
    const rawBody = '{}';
    const svixId = `msg_${randomUUID()}`;
    const svixTimestampViejo = String(Math.floor(Date.now() / 1000) - 10_000);
    const svixSignature = sign(svixId, svixTimestampViejo, rawBody);

    const mailResult = verifyResendWebhookSignature(rawBody, { svixId, svixTimestamp: svixTimestampViejo, svixSignature }, SECRET);
    expect(mailResult).toEqual({ ok: false, reason: 'timestamp_fuera_de_rango' });

    const verify = createHmacWebhookGuard({ scheme: createSvixScheme(), getSecret: () => SECRET, notConfiguredMessage: 'x' });
    const err = await captureRejection(
      verify(rawBody, { 'svix-id': svixId, 'svix-timestamp': svixTimestampViejo, 'svix-signature': svixSignature }),
    );
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('ambos ACEPTAN cuando svix-signature trae varias firmas separadas por espacio (rotación de secreto)', async () => {
    const rawBody = '{}';
    const svixId = `msg_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const valida = sign(svixId, svixTimestamp, rawBody);
    const svixSignature = `v1,firmavieja-invalida ${valida}`;

    const mailResult = verifyResendWebhookSignature(rawBody, { svixId, svixTimestamp, svixSignature }, SECRET);
    expect(mailResult).toEqual({ ok: true });

    const verify = createHmacWebhookGuard({ scheme: createSvixScheme(), getSecret: () => SECRET, notConfiguredMessage: 'x' });
    await expect(verify(rawBody, { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': svixSignature })).resolves.toEqual({
      eventId: svixId,
    });
  });

  it('ambos RECHAZAN el secreto equivocado', async () => {
    const rawBody = '{}';
    const svixId = `msg_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const svixSignature = sign(svixId, svixTimestamp, rawBody);
    const otroSecreto = `whsec_${Buffer.from('otro-secreto-completamente-distinto').toString('base64')}`;

    const mailResult = verifyResendWebhookSignature(rawBody, { svixId, svixTimestamp, svixSignature }, otroSecreto);
    expect(mailResult).toEqual({ ok: false, reason: 'firma_invalida' });

    const verify = createHmacWebhookGuard({ scheme: createSvixScheme(), getSecret: () => otroSecreto, notConfiguredMessage: 'x' });
    const err = await captureRejection(verify(rawBody, { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': svixSignature }));
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('el middleware genérico también aplica el paso adicional de deduplicación (409 en replay) que un caller de verifyResendWebhookSignature a secas debe implementar aparte', async () => {
    const rawBody = '{}';
    const svixId = `msg_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const svixSignature = sign(svixId, svixTimestamp, rawBody);
    const headers = { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': svixSignature };

    const { InMemoryWebhookReplayGuard } = await import('@atiende/webhooks');
    const verify = createHmacWebhookGuard({
      scheme: createSvixScheme(),
      getSecret: () => SECRET,
      notConfiguredMessage: 'x',
      replayGuard: new InMemoryWebhookReplayGuard(),
    });
    await expect(verify(rawBody, headers)).resolves.toEqual({ eventId: svixId });
    const err = await captureRejection(verify(rawBody, headers));
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('falla cerrado (503) si el secreto no está configurado, igual que POST /webhooks/mail/:provider', async () => {
    const verify = createHmacWebhookGuard({ scheme: createSvixScheme(), getSecret: () => undefined, notConfiguredMessage: 'Falta X_WEBHOOK_SECRET' });
    const err = await captureRejection(verify('{}', { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'v1,x' }));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(503);
  });
});
