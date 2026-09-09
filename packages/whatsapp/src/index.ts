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

export type { WhatsAppProvider, OutboundWhatsAppMessage, SendResult } from "./provider/types";
export { CaptureProvider } from "./provider/capture-provider";
export type { CapturedWhatsAppMessage, CaptureProviderOptions } from "./provider/capture-provider";
export { createMetaCloudProvider } from "./provider/meta-cloud-provider";
export type { MetaCloudProviderOptions } from "./provider/meta-cloud-provider";
export { createWhatsAppProviderFromEnv } from "./provider/factory";
export type { WhatsAppEnv, WhatsAppProviderKind } from "./provider/factory";
