import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Callout, Title } from "../../components/blocks";
import { BaseVariablesSchema } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const PendingApprovalVariablesSchema = BaseVariablesSchema.extend({
  approvalType: z.enum(["tarifa", "expediente", "tool_call"]),
  /** Convocatoria o expediente al que pertenece la aprobación — es lo que
   *  aparece en el asunto (REQ-181, plantilla 7: "... en {convocatoria}"). */
  contextLabel: z.string().min(1),
  subjectLabel: z.string().min(1),
  requestedBy: z.string().min(1),
  requestSummary: z.string().min(1),
  approvalUrl: z.string().url(),
});

export type PendingApprovalVariables = z.infer<typeof PendingApprovalVariablesSchema>;

const APPROVAL_TYPE_LABEL: Record<PendingApprovalVariables["approvalType"], string> = {
  tarifa: "Tarifa / cotización",
  expediente: "Expediente",
  tool_call: "Acción de un agente",
};

export const pendingApprovalTemplate: TemplateDefinition<PendingApprovalVariables> = {
  id: "pending-approval",
  name: "Aprobación pendiente (tarifa/expediente/tool_call)",
  category: "approvals",
  mandatory: false,
  schema: PendingApprovalVariablesSchema,
  sampleData: {
    recipientName: "Ana Torres (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    approvalType: "tool_call",
    contextLabel: "Suministro de equipo de cómputo para oficinas regionales (ejemplo)",
    subjectLabel: "Enviar propuesta técnica a la convocatoria demo-001 (ejemplo)",
    requestedBy: "Agente de preparación de expedientes (ejemplo)",
    requestSummary: "El agente preparó la propuesta técnica y pide autorización antes de enviarla a la convocante (ejemplo).",
    approvalUrl: "https://app.atiende.mx/aprobaciones/demo-001",
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 7).
    const subject = `Una acción espera tu aprobación en ${vars.contextLabel}`;
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader="Nada se envía ni se firma sin tu autorización explícita."
        tone="atencion"
        reason="Te llegó este mensaje porque tienes permisos de aprobación en esta organización."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>Tienes una aprobación pendiente</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>{vars.requestSummary}</Paragraph>
        <DataTable
          rows={[
            { label: "Acción", value: vars.subjectLabel },
            { label: "Tipo", value: APPROVAL_TYPE_LABEL[vars.approvalType] },
            { label: "Solicitado por", value: vars.requestedBy },
          ]}
        />
        <CtaButton label="Revisar y decidir" href={vars.approvalUrl} appUrl={vars.appUrl} />
        <Callout>
          Ningún agente de Atiende actúa sobre esto sin tu autorización: puedes aprobar, rechazar o pedir cambios
          desde el enlace de arriba.
        </Callout>
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
