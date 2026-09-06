import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const NewTenderMatchVariablesSchema = BaseVariablesSchema.extend({
  tenderTitle: z.string().min(1),
  contractingEntity: z.string().min(1),
  matchScore: z.number().int().min(0).max(100),
  estimatedValue: z.string().min(1),
  submissionDeadlineIso: z.string().min(1),
  tenderUrl: z.string().url(),
});

export type NewTenderMatchVariables = z.infer<typeof NewTenderMatchVariablesSchema>;

export const newTenderMatchTemplate: TemplateDefinition<NewTenderMatchVariables> = {
  id: "new-tender-match",
  name: "Nueva convocatoria relevante (matching)",
  category: "tender_matches",
  mandatory: false,
  schema: NewTenderMatchVariablesSchema,
  sampleData: {
    recipientName: "Roberto Salinas (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    tenderTitle: "Suministro de equipo de cómputo para oficinas regionales (ejemplo)",
    contractingEntity: "Secretaría de Ejemplo del Estado (ejemplo)",
    matchScore: 92,
    estimatedValue: "$4,850,000.00 MXN (ejemplo)",
    submissionDeadlineIso: "2026-10-02T18:00:00.000Z",
    tenderUrl: "https://app.atiende.mx/convocatorias/demo-001",
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 5, variante "convocatoria nueva").
    const subject = `Nueva convocatoria: ${vars.tenderTitle}`;
    const deadline = formatFechaEs(vars.submissionDeadlineIso);
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`Coincidencia del ${vars.matchScore}% con tu perfil. Cierra el ${deadline}.`}
        reason="Te llegó este mensaje porque tienes activas las alertas de coincidencia de convocatorias."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>Nueva convocatoria para ti</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          Encontramos una convocatoria con {vars.matchScore}% de coincidencia con el perfil de tu empresa:{" "}
          <strong>{vars.tenderTitle}</strong>, de {vars.contractingEntity}.
        </Paragraph>
        <DataTable
          rows={[
            { label: "Convocante", value: vars.contractingEntity },
            { label: "Coincidencia", value: `${vars.matchScore}%` },
            { label: "Monto estimado", value: vars.estimatedValue },
            { label: "Cierre de propuestas", value: deadline },
          ]}
        />
        <CtaButton label="Ver convocatoria completa" href={vars.tenderUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
