// ─────────────────────────────────────────────────────────────────────────
// @atiende/whatsapp — canal ADICIONAL (nunca en reemplazo del correo) de
// notificación por WhatsApp para Atiende Licitaciones, vía Meta WhatsApp
// Business Cloud API. Ver README.md para las variables de entorno y la
// restricción de plantillas pre-aprobadas de Meta.
//
// El wiring que decide CUÁNDO mandar un WhatsApp (qué categorías, cómo se
// combina con las preferencias de correo, de dónde sale el número de
// teléfono del destinatario) vive en `apps/api` — este paquete, igual que
// `@atiende/mail`, es una librería TypeScript pura: solo el contrato
// (`WhatsAppProvider`) y sus implementaciones (capture para dev/test, Meta
// para producción una vez que existan credenciales reales).
// ─────────────────────────────────────────────────────────────────────────

export type {
  WhatsAppProvider,
  OutboundWhatsAppMessage,
  SendResult,
  OutboundInteractiveListMessage,
  InteractiveListRow,
  InteractiveListSection,
} from "./provider/types";
export { CaptureProvider } from "./provider/capture-provider";
export type { CapturedWhatsAppMessage, CapturedInteractiveListMessage, CapturedTextMessage, CaptureProviderOptions } from "./provider/capture-provider";
export { createMetaCloudProvider } from "./provider/meta-cloud-provider";
export type { MetaCloudProviderOptions } from "./provider/meta-cloud-provider";
export { createWhatsAppProviderFromEnv } from "./provider/factory";
export type { WhatsAppEnv, WhatsAppProviderKind } from "./provider/factory";
export {
  MAX_QUICK_REPLY_BUTTONS,
  MAX_LIST_ROWS_TOTAL,
  MAX_BUTTON_TITLE_LENGTH,
  MAX_LIST_ROW_TITLE_LENGTH,
  MAX_LIST_ROW_DESCRIPTION_LENGTH,
  MAX_LIST_BUTTON_TEXT_LENGTH,
  validateButtonPayloads,
  validateInteractiveListMessage,
} from "./provider/content-limits";
export type { ContentLimitResult } from "./provider/content-limits";

// REQ-090/074/080: webhook entrante (decisión vía botones/listas).
export { parseWhatsAppWebhookPayload } from "./webhook/parse-payload";
export { verifyMetaWebhookSignature } from "./webhook/verify-signature";
export type { VerifyMetaWebhookSignatureResult } from "./webhook/verify-signature";
export { InMemoryWamidReplayGuard } from "./webhook/replay-guard";
export type { WamidReplayGuard } from "./webhook/replay-guard";
export { resolveWebhookSubscriptionChallenge } from "./webhook/subscription-challenge";
export { toE164FromMetaPhone } from "./webhook/types";
export type { WhatsAppInboundInteraction, WhatsAppInboundInteractionKind } from "./webhook/types";
