import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const DeadlineReminderVariablesSchema = BaseVariablesSchema.extend({
  tenderTitle: z.string().min(1),
  submissionDeadlineIso: z.string().min(1),
  hoursRemaining: z.number().int().positive(),
  actionUrl: z.string().url(),
});

export type DeadlineReminderVariables = z.infer<typeof DeadlineReminderVariablesSchema>;

export const deadlineReminderTemplate: TemplateDefinition<DeadlineReminderVariables> = {
  id: "deadline-reminder",
  name: "Recordatorio de plazo",
  category: "deadlines",
  mandatory: false,
  schema: DeadlineReminderVariablesSchema,
  sampleData: {
    recipientName: "Roberto Salinas (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    tenderTitle: "Suministro de equipo de cómputo para oficinas regionales (ejemplo)",
    submissionDeadlineIso: "2026-10-07T18:00:00.000Z",
    hoursRemaining: 48,
    actionUrl: "https://app.atiende.mx/convocatorias/demo-001",
  },
  async render(vars) {
    const subject = `Vence en ${vars.hoursRemaining} horas: ${vars.tenderTitle}`;
    const deadline = formatFechaEs(vars.submissionDeadlineIso);
    const urgente = vars.hoursRemaining <= 24;
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`El plazo de ${vars.tenderTitle} cierra el ${deadline}.`}
        tone={urgente ? "urgente" : "atencion"}
        reason="Te llegó este mensaje porque das seguimiento a esta convocatoria en Atiende Licitaciones."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>Se acerca el cierre de propuestas</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          Quedan {vars.hoursRemaining} horas para el cierre de propuestas de <strong>{vars.tenderTitle}</strong>.
        </Paragraph>
        <DataTable rows={[{ label: "Cierre de propuestas", value: deadline }]} />
        <CtaButton label="Revisar mi avance" href={vars.actionUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
