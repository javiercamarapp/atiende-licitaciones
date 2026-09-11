import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryWebhookReplayGuard } from '@atiende/webhooks';
import { AppError, ConflictError, UnauthorizedError } from '../../../src/lib/errors.js';
import { createHmacWebhookGuard, type HmacWebhookScheme } from '../../../src/lib/webhooks/hmac-webhook-guard.js';

/**
 * REQ-096: pruebas del middleware genérico contra un esquema DE JUGUETE
 * (no Svix — eso lo cubre `svix-scheme.test.ts`) para demostrar que
 * `createHmacWebhookGuard` sirve para CUALQUIER esquema HMAC, no solo el
 * de Resend. El esquema de prueba firma `sha256=<hex>` sobre el cuerpo
 * crudo tal cual, sin timestamp — estilo GitHub/Stripe, deliberadamente
 * distinto del de Svix para probar que el middleware no está acoplado a
 * ningún detalle de un proveedor concreto.
 */
const SECRET = 'un-secreto-de-prueba-cualquiera';

function toyScheme(): HmacWebhookScheme {
  return {
    encoding: 'hex',
    parseHeaders(headers) {
      const eventId = String(headers['x-event-id'] ?? '');
      const sigHeader = String(headers['x-signature'] ?? '');
      if (!eventId || !sigHeader) return null;
      const prefix = 'sha256=';
      if (!sigHeader.startsWith(prefix)) return null;
      return { eventId, signatureCandidates: [sigHeader.slice(prefix.length)] };
    },
    buildSignedContent(rawBody) {
      return rawBody;
    },
    decodeSecret(secret) {
      return secret.length > 0 ? Buffer.from(secret) : null;
    },
  };
}

function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', Buffer.from(secret)).update(rawBody).digest('hex')}`;
}

function headersFor(eventId: string, rawBody: string, options: { secret?: string; signature?: string } = {}) {
  return {
    'x-event-id': eventId,
    'x-signature': options.signature ?? sign(rawBody, options.secret),
  };
}

/** Espera a que `promise` rechace y devuelve el error, en vez de que `expect(...).rejects` lo trague. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba que la promesa fallara, pero resolvió');
}

describe('createHmacWebhookGuard', () => {
  it('acepta una petición con firma válida y devuelve el eventId', async () => {
    const verify = createHmacWebhookGuard({
      scheme: toyScheme(),
      getSecret: () => SECRET,
      notConfiguredMessage: 'no configurado',
    });
    const rawBody = JSON.stringify({ tipo: 'creado' });
    const eventId = randomUUID();
    const result = await verify(rawBody, headersFor(eventId, rawBody));
    expect(result).toEqual({ eventId });
  });

  it('falla CERRADO con 503 si no hay secreto configurado (nunca "acepta cualquier cosa")', async () => {
    const verify = createHmacWebhookGuard({
      scheme: toyScheme(),
      getSecret: () => undefined,
      notConfiguredMessage: 'Falta MI_WEBHOOK_SECRET',
    });
    const rawBody = '{}';
    const err = await captureRejection(verify(rawBody, headersFor('evt_1', rawBody)));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).message).toBe('Falta MI_WEBHOOK_SECRET');
  });

  it('falla CERRADO con 503 si el secreto configurado no tiene un formato válido para el esquema (distinto de "no configurado")', async () => {
    // `getSecret()` sí devuelve algo (no es el caso "falta la env var") pero
    // `decodeSecret` del esquema lo rechaza -- p. ej. un secreto Svix sin
    // el material base64 esperado tras el prefijo `whsec_`.
    const verify = createHmacWebhookGuard({
      scheme: { ...toyScheme(), decodeSecret: () => null },
      getSecret: () => SECRET,
      notConfiguredMessage: 'Falta MI_WEBHOOK_SECRET',
    });
    const rawBody = '{}';
    const err = await captureRejection(verify(rawBody, headersFor('evt_1', rawBody)));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).message).toBe('Falta MI_WEBHOOK_SECRET');
  });

  it('rechaza con 401 cuando faltan cabeceras obligatorias del esquema', async () => {
    const verify = createHmacWebhookGuard({
      scheme: toyScheme(),
      getSecret: () => SECRET,
      notConfiguredMessage: 'no configurado',
    });
    const err = await captureRejection(verify('{}', {}));
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as AppError).statusCode).toBe(401);
  });

  it('rechaza con 401 una firma inválida (cuerpo alterado después de firmar)', async () => {
    const verify = createHmacWebhookGuard({
      scheme: toyScheme(),
      getSecret: () => SECRET,
      notConfiguredMessage: 'no configurado',
    });
    const rawBody = JSON.stringify({ tipo: 'original' });
    const headers = headersFor('evt_1', rawBody);
    const alterado = JSON.stringify({ tipo: 'alterado' });
    const err = await captureRejection(verify(alterado, headers));
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as AppError).statusCode).toBe(401);
  });

  it('rechaza con 401 una firma calculada con el secreto equivocado', async () => {
    const verify = createHmacWebhookGuard({
      scheme: toyScheme(),
      getSecret: () => SECRET,
      notConfiguredMessage: 'no configurado',
    });
    const rawBody = '{}';
    const headers = headersFor('evt_1', rawBody, { secret: 'otro-secreto-distinto' });
    const err = await captureRejection(verify(rawBody, headers));
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as AppError).statusCode).toBe(401);
  });

  it('sin replayGuard configurado, el MISMO eventId puede procesarse varias veces (dedup es opt-in)', async () => {
    const verify = createHmacWebhookGuard({
      scheme: toyScheme(),
      getSecret: () => SECRET,
      notConfiguredMessage: 'no configurado',
    });
    const rawBody = '{}';
    const headers = headersFor('evt_repetido', rawBody);
    expect(await verify(rawBody, headers)).toEqual({ eventId: 'evt_repetido' });
    expect(await verify(rawBody, headers)).toEqual({ eventId: 'evt_repetido' });
  });

  it('con replayGuard configurado, la segunda entrega del MISMO eventId se rechaza con 409', async () => {
    const replayGuard = new InMemoryWebhookReplayGuard();
    const verify = createHmacWebhookGuard({
      scheme: toyScheme(),
      getSecret: () => SECRET,
      notConfiguredMessage: 'no configurado',
      replayGuard,
    });
    const rawBody = '{}';
    const headers = headersFor('evt_repetido', rawBody);
    expect(await verify(rawBody, headers)).toEqual({ eventId: 'evt_repetido' });
    const err = await captureRejection(verify(rawBody, headers));
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as AppError).statusCode).toBe(409);
  });

  it('una firma inválida NUNCA reclama el eventId del replay guard (no "gasta" un id legítimo futuro)', async () => {
    const replayGuard = new InMemoryWebhookReplayGuard();
    const verify = createHmacWebhookGuard({
      scheme: toyScheme(),
      getSecret: () => SECRET,
      notConfiguredMessage: 'no configurado',
      replayGuard,
    });
    const rawBody = '{}';
    const headersForjados = headersFor('evt_1', rawBody, { signature: 'sha256=' + '0'.repeat(64) });
    const err = await captureRejection(verify(rawBody, headersForjados));
    expect(err).toBeInstanceOf(UnauthorizedError);

    const headersLegitimos = headersFor('evt_1', rawBody);
    expect(await verify(rawBody, headersLegitimos)).toEqual({ eventId: 'evt_1' });
  });

  it('dos guardias de replay SEPARADOS (uno por proveedor) no colisionan aunque compartan eventId', async () => {
    const guardA = new InMemoryWebhookReplayGuard();
    const guardB = new InMemoryWebhookReplayGuard();
    const verifyA = createHmacWebhookGuard({ scheme: toyScheme(), getSecret: () => SECRET, notConfiguredMessage: 'x', replayGuard: guardA });
    const verifyB = createHmacWebhookGuard({ scheme: toyScheme(), getSecret: () => SECRET, notConfiguredMessage: 'x', replayGuard: guardB });
    const rawBody = '{}';
    const headers = headersFor('evt_compartido', rawBody);
    expect(await verifyA(rawBody, headers)).toEqual({ eventId: 'evt_compartido' });
    expect(await verifyB(rawBody, headers)).toEqual({ eventId: 'evt_compartido' });
  });
});
