import { emailVerificationTemplate } from "./catalog/email-verification";
import { organizationInviteTemplate } from "./catalog/organization-invite";
import { passwordResetTemplate } from "./catalog/password-reset";
import { twoFactorEnabledTemplate } from "./catalog/two-factor-enabled";
import { backupCodesGeneratedTemplate } from "./catalog/backup-codes-generated";
import { welcomeOnboardingTemplate } from "./catalog/welcome-onboarding";
import { newTenderMatchTemplate } from "./catalog/new-tender-match";
import { tenderMatchDigestTemplate } from "./catalog/tender-match-digest";
import { tenderChangeTemplate } from "./catalog/tender-change";
import { pendingApprovalTemplate } from "./catalog/pending-approval";
import { submissionPackageReadyTemplate } from "./catalog/submission-package-ready";
import { deadlineReminderTemplate } from "./catalog/deadline-reminder";
import { documentExpirationTemplate } from "./catalog/document-expiration";
import { postAwardAlertTemplate } from "./catalog/post-award-alert";
import { weeklySummaryTemplate } from "./catalog/weekly-summary";
import { contactReceivedTemplate } from "./catalog/contact-received";
import type { AnyTemplateDefinition, TemplateDefinition } from "./types";

/**
 * El catálogo completo de correos de Atiende Licitaciones (ronda 6). Cada
 * entrada es la MISMA instancia que exporta su archivo — no hay copias:
 * `registry` es solo el índice por `id` que usan `MailService`,
 * `scripts/preview.ts` y las pruebas.
 */
export const templateRegistry = {
  [emailVerificationTemplate.id]: emailVerificationTemplate,
  [organizationInviteTemplate.id]: organizationInviteTemplate,
  [passwordResetTemplate.id]: passwordResetTemplate,
  [twoFactorEnabledTemplate.id]: twoFactorEnabledTemplate,
  [backupCodesGeneratedTemplate.id]: backupCodesGeneratedTemplate,
  [welcomeOnboardingTemplate.id]: welcomeOnboardingTemplate,
  [newTenderMatchTemplate.id]: newTenderMatchTemplate,
  [tenderMatchDigestTemplate.id]: tenderMatchDigestTemplate,
  [tenderChangeTemplate.id]: tenderChangeTemplate,
  [pendingApprovalTemplate.id]: pendingApprovalTemplate,
  [submissionPackageReadyTemplate.id]: submissionPackageReadyTemplate,
  [deadlineReminderTemplate.id]: deadlineReminderTemplate,
  [documentExpirationTemplate.id]: documentExpirationTemplate,
  [postAwardAlertTemplate.id]: postAwardAlertTemplate,
  [weeklySummaryTemplate.id]: weeklySummaryTemplate,
  [contactReceivedTemplate.id]: contactReceivedTemplate,
} satisfies Record<string, AnyTemplateDefinition>;

export type TemplateId = keyof typeof templateRegistry;

export function listTemplates(): AnyTemplateDefinition[] {
  return Object.values(templateRegistry);
}

export function getTemplate(id: string): AnyTemplateDefinition | undefined {
  return (templateRegistry as Record<string, AnyTemplateDefinition | undefined>)[id];
}

export function requireTemplate(id: string): AnyTemplateDefinition {
  const template = getTemplate(id);
  if (!template) {
    throw new Error(`No existe la plantilla de correo "${id}". Revisa templateRegistry en registry.ts.`);
  }
  return template;
}

export type {
  AnyTemplateDefinition,
  TemplateDefinition,
};
