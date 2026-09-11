/**
 * REQ-096: el anti-replay de webhooks (ML-05) se generalizó a
 * `@atiende/webhooks` (`WebhookReplayGuard`/`InMemoryWebhookReplayGuard`,
 * antes definidos aquí con el parámetro nombrado `svixId`) para que
 * cualquier webhook entrante NUEVO lo reutilice, no solo el de correo — ver
 * `packages/webhooks/README.md` para el porqué y `hmac.ts`/`verify.ts` de
 * ese paquete para la verificación de firma que ahora también se comparte.
 *
 * Este archivo se conserva como RE-EXPORTACIÓN para no romper el import
 * público de `@atiende/mail` que ya consumían `apps/api`
 * (`PgWebhookReplayGuard`, ver `apps/api/src/lib/mail/pg-webhook-replay-guard.ts`)
 * y las pruebas existentes de este paquete: siguen importando
 * `WebhookReplayGuard`/`InMemoryWebhookReplayGuard` desde
 * `"../../src/webhooks/replay-guard"` sin ningún cambio. El contrato
 * (`claim(eventId, toleranceSeconds, now)`) es el mismo de siempre, solo
 * con el parámetro nombrado de forma genérica en vez de `svixId` — un
 * cambio de nombre que no afecta la firma en tiempo de ejecución
 * (TypeScript, posicional).
 */
export type { WebhookReplayGuard } from "@atiende/webhooks";
export { InMemoryWebhookReplayGuard } from "@atiende/webhooks";
