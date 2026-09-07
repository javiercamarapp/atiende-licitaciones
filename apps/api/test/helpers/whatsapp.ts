import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CaptureProvider, CapturedWhatsAppMessage } from '@atiende/whatsapp';

/**
 * Canal ADICIONAL de WhatsApp (`lib/mail/whatsapp-channel.ts`): utilidades
 * de prueba equivalentes a `test/helpers/mail.ts`, mismo criterio -- sin
 * `WHATSAPP_PROVIDER` (ninguna suite la define), `createWhatsAppProviderFromEnv`
 * arma un `CaptureProvider` (nunca sale a la red, nunca a la Cloud API real
 * de Meta).
 */
export function whatsappCapture(app: FastifyInstance): CaptureProvider {
  const provider = app.whatsapp;
  expect(provider.name).toBe('capture');
  return provider as CaptureProvider;
}

/** Todo lo "enviado" por WhatsApp hasta ahora. Los trigger functions de `triggers.ts`
 *  llaman a `sendWhatsAppSideChannel` con `await` (nunca fire-and-forget, a diferencia
 *  del correo), así que no hace falta esperar ninguna cola en segundo plano aquí. */
export function allWhatsAppMessages(app: FastifyInstance): CapturedWhatsAppMessage[] {
  return whatsappCapture(app).list();
}

export function lastWhatsAppTo(app: FastifyInstance, to: string): CapturedWhatsAppMessage | undefined {
  return whatsappCapture(app).findLastTo(to);
}
