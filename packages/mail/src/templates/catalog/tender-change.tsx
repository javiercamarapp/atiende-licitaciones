import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const TenderChangeVariablesSchema = BaseVariablesSchema.extend({
  tenderTitle: z.string().min(1),
  changeType: z.enum(["version", "plazo", "otro"]),
  changeSummary: z.string().min(1),
  previousDeadlineIso: z.string().optional(),
  newDeadlineIso: z.string().optional(),
  tenderUrl: z.string().url(),
});

export type TenderChangeVariables = z.infer<typeof TenderChangeVariablesSchema>;

const CHANGE_TYPE_LABEL: Record<TenderChangeVariables["changeType"], string> = {
  version: "Nueva versión de bases",
  plazo: "Cambio de plazo",
  otro: "Actualización",
};

export const tenderChangeTemplate: TemplateDefinition<TenderChangeVariables> = {
  id: "tender-change",
  name: "Cambio en convocatoria (versión/plazo)",
  category: "tender_changes",
  mandatory: false,
  schema: TenderChangeVariablesSchema,
  sampleData: {
    recipientName: "Roberto Salinas (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    tenderTitle: "Suministro de equipo de cómputo para oficinas regionales (ejemplo)",
    changeType: "plazo",
    changeSummary: "La convocante extendió el cierre de propuestas 5 días naturales (ejemplo).",
    previousDeadlineIso: "2026-10-02T18:00:00.000Z",
    newDeadlineIso: "2026-10-07T18:00:00.000Z",
    tenderUrl: "https://app.atiende.mx/convocatorias/demo-001",
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 5, variante "cambio").
    const subject = `Cambio en convocatoria: ${vars.tenderTitle}`;
    const rows = [{ label: "Tipo de cambio", value: CHANGE_TYPE_LABEL[vars.changeType] }];
    if (vars.previousDeadlineIso) rows.push({ label: "Plazo anterior", value: formatFechaEs(vars.previousDeadlineIso) });
    if (vars.newDeadlineIso) rows.push({ label: "Plazo nuevo", value: formatFechaEs(vars.newDeadlineIso) });
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={vars.changeSummary}
        tone="atencion"
        reason="Te llegó este mensaje porque sigues esta convocatoria en Atiende Licitaciones."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>Hubo un cambio en tu convocatoria</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          <strong>{vars.tenderTitle}</strong> tuvo una actualización que puede afectar tu propuesta: {vars.changeSummary}
        </Paragraph>
        <DataTable rows={rows} />
        <CtaButton label="Ver el cambio completo" href={vars.tenderUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
