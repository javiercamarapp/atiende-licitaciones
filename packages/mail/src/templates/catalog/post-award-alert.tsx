import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const PostAwardAlertVariablesSchema = BaseVariablesSchema.extend({
  tenderTitle: z.string().min(1),
  alertType: z.enum(["pago", "garantia"]),
  details: z.string().min(1),
  dueDateIso: z.string().min(1),
  /** Días restantes hasta `dueDateIso` (puede ser 0 o negativo si ya venció)
   *  — es lo que arma el asunto (REQ-181, plantilla 9). El llamador lo
   *  calcula al encolar el envío, no esta plantilla: así el asunto y el
   *  cuerpo siempre coinciden con el momento real del envío, no con el
   *  momento en que se generó `dueDateIso`. */
  daysRemaining: z.number().int(),
  actionUrl: z.string().url(),
});

export type PostAwardAlertVariables = z.infer<typeof PostAwardAlertVariablesSchema>;

const ALERT_TYPE_LABEL: Record<PostAwardAlertVariables["alertType"], string> = {
  pago: "Pago pendiente",
  garantia: "Garantía",
};

export const postAwardAlertTemplate: TemplateDefinition<PostAwardAlertVariables> = {
  id: "post-award-alert",
  name: "Alerta post-adjudicación (pago/garantía)",
  category: "post_award",
  mandatory: false,
  schema: PostAwardAlertVariablesSchema,
  sampleData: {
    recipientName: "Ana Torres (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    tenderTitle: "Suministro de equipo de cómputo para oficinas regionales (ejemplo)",
    alertType: "garantia",
    details: "La convocante pide la fianza de cumplimiento dentro de los 10 días naturales siguientes a la firma (ejemplo).",
    dueDateIso: "2026-10-20T00:00:00.000Z",
    daysRemaining: 10,
    actionUrl: "https://app.atiende.mx/adjudicaciones/demo-001",
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 9): "Vence en {días} día(s): {obligación} de
    // {convocatoria}".
    const dias = Math.max(0, vars.daysRemaining);
    const subject = `Vence en ${dias} día${dias === 1 ? "" : "s"}: ${ALERT_TYPE_LABEL[vars.alertType]} de ${vars.tenderTitle}`;
    const vencido = vars.daysRemaining <= 0;
    const rows = [
      { label: "Tipo de obligación", value: ALERT_TYPE_LABEL[vars.alertType] },
      { label: "Fecha límite", value: formatFechaEs(vars.dueDateIso) },
    ];
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={vars.details}
        tone={vencido ? "urgente" : "atencion"}
        reason="Te llegó este mensaje porque tu empresa resultó adjudicada en esta convocatoria."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>Pendiente tras la adjudicación</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          Tienes un pendiente relacionado con <strong>{vars.tenderTitle}</strong>: {vars.details}
        </Paragraph>
        <DataTable rows={rows} />
        <CtaButton label="Ver detalles" href={vars.actionUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
