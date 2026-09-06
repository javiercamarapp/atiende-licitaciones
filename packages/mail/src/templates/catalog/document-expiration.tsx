import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const DocumentExpirationVariablesSchema = BaseVariablesSchema.extend({
  documentName: z.string().min(1),
  expiresOnIso: z.string().min(1),
  daysRemaining: z.number().int(),
  renewUrl: z.string().url(),
});

export type DocumentExpirationVariables = z.infer<typeof DocumentExpirationVariablesSchema>;

export const documentExpirationTemplate: TemplateDefinition<DocumentExpirationVariables> = {
  id: "document-expiration",
  name: "Vencimiento de documento",
  category: "document_expiration",
  mandatory: false,
  schema: DocumentExpirationVariablesSchema,
  sampleData: {
    recipientName: "Ana Torres (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    documentName: "Opinión de cumplimiento fiscal (ejemplo)",
    expiresOnIso: "2026-09-20T00:00:00.000Z",
    daysRemaining: 14,
    renewUrl: "https://app.atiende.mx/expediente/documentos/demo-002",
  },
  async render(vars) {
    const subject = `Documento por vencer: ${vars.documentName}`;
    const expiresOn = formatFechaEs(vars.expiresOnIso);
    const vencido = vars.daysRemaining <= 0;
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={
          vencido
            ? `${vars.documentName} ya venció. Actualízalo antes de tu próxima presentación.`
            : `${vars.documentName} vence en ${vars.daysRemaining} días.`
        }
        tone={vencido ? "urgente" : "atencion"}
        reason="Te llegó este mensaje porque este documento forma parte del expediente permanente de tu empresa."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>{vencido ? "Un documento venció" : "Un documento está por vencer"}</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          {vencido
            ? `${vars.documentName} venció el ${expiresOn}. Varias convocatorias lo piden vigente al momento de presentar.`
            : `${vars.documentName} vence en ${vars.daysRemaining} días (${expiresOn}). Actualízalo para no quedar fuera de una convocatoria por documentación caduca.`}
        </Paragraph>
        <DataTable
          rows={[
            { label: "Documento", value: vars.documentName },
            { label: "Vencimiento", value: expiresOn },
          ]}
        />
        <CtaButton label="Actualizar documento" href={vars.renewUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
