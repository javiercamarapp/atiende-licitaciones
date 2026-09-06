// ─────────────────────────────────────────────────────────────────────────
// @atiende/mail — motor de plantillas y servicio de envío de correo de
// Atiende Licitaciones (ronda 6). Ver README.md para cómo lo integran
// apps/api y apps/worker, y las variables de entorno que necesita cada
// MailProvider.
// ─────────────────────────────────────────────────────────────────────────

export * from "./theme";

export { EmailLayout, LEGAL_FOOTER_PLACEHOLDER } from "./components/EmailLayout";
export type { EmailLayoutProps } from "./components/EmailLayout";
export { AtiendeLogoMark, AtiendeWordmarkText } from "./components/AtiendeLogo";
export * from "./components/blocks";

export { safeUrl } from "./security/safe-url";
export { createLinkSigner } from "./security/signed-link";
export type { LinkSigner, SignedLinkPayload, VerifySignedLinkResult } from "./security/signed-link";

export * from "./preferences/types";
export { isCategoryEnabled } from "./preferences/filter";

export * from "./recipients/types";

export * from "./suppression/types";

export * from "./webhooks/types";
export { verifyResendWebhookSignature } from "./webhooks/verify-signature";
export type { WebhookSignatureHeaders, VerifyWebhookOptions, VerifyWebhookResult } from "./webhooks/verify-signature";
export { applyMailWebhookEvent } from "./webhooks/apply-event";
export { parseResendWebhookPayload } from "./webhooks/parse-resend-payload";

export { BaseVariablesSchema, formatFechaEs } from "./templates/common";
export type { BaseVariables } from "./templates/common";
export type { RenderedEmail, TemplateDefinition, AnyTemplateDefinition } from "./templates/types";
export { renderEmailParts } from "./templates/render-html";
export { templateRegistry, listTemplates, getTemplate, requireTemplate } from "./templates/registry";
export type { TemplateId } from "./templates/registry";

export * from "./templates/catalog/email-verification";
export * from "./templates/catalog/organization-invite";
export * from "./templates/catalog/password-reset";
export * from "./templates/catalog/two-factor-enabled";
export * from "./templates/catalog/backup-codes-generated";
export * from "./templates/catalog/welcome-onboarding";
export * from "./templates/catalog/new-tender-match";
export * from "./templates/catalog/tender-match-digest";
export * from "./templates/catalog/tender-change";
export * from "./templates/catalog/pending-approval";
export * from "./templates/catalog/submission-package-ready";
export * from "./templates/catalog/deadline-reminder";
export * from "./templates/catalog/document-expiration";
export * from "./templates/catalog/post-award-alert";
export * from "./templates/catalog/weekly-summary";
export * from "./templates/catalog/contact-received";

export type { MailProvider, OutboundEmail, OutboundAttachment, SendResult } from "./provider/types";
export { classifyHttpStatus } from "./provider/types";
export { createResendProvider } from "./provider/resend-provider";
export type { ResendProviderOptions } from "./provider/resend-provider";
export { createPostmarkProvider } from "./provider/postmark-provider";
export type { PostmarkProviderOptions } from "./provider/postmark-provider";
export { createSmtpProvider, classifySmtpCode } from "./provider/smtp-provider";
export type { SmtpProviderOptions } from "./provider/smtp-provider";
export { CaptureProvider } from "./provider/capture-provider";
export type { CapturedEmail, CaptureProviderOptions } from "./provider/capture-provider";
export { createMailProviderFromEnv } from "./provider/factory";
export type { MailEnv, MailProviderKind } from "./provider/factory";

export { MailService } from "./service/mail-service";
export type { MailServiceOptions, SendMailInput, SendOutcome } from "./service/mail-service";
export { DEFAULT_RETRY_POLICY, computeBackoffDelay } from "./service/retry";
export type { RetryPolicy } from "./service/retry";
export { TokenBucketRateLimiter, UnlimitedRateLimiter } from "./service/rate-limiter";
export type { RateLimiter } from "./service/rate-limiter";
export { InMemorySendRecordStore } from "./service/send-store";
export type { SendRecord, SendRecordStore, SendStatus } from "./service/send-store";
