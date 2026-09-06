import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

/**
 * Correo INTERNO: se manda al equipo de Atiende (destinatarios registrados
 * como staff), no a un cliente — por eso su categoría es `internal`
 * (obligatoria, no aparece en el centro de preferencias de un cliente).
 */
export const ContactReceivedVariablesSchema = BaseVariablesSchema.extend({
  contactName: z.string().min(1),
  contactEmail: z.string().email(),
  contactPhone: z.string().optional(),
  message: z.string().min(1),
  receivedAtIso: z.string().min(1),
  source: z.enum(["landing", "formulario_contacto"]),
  adminUrl: z.string().url(),
});

export type ContactReceivedVariables = z.infer<typeof ContactReceivedVariablesSchema>;

const SOURCE_LABEL: Record<ContactReceivedVariables["source"], string> = {
  landing: "Landing pública",
  formulario_contacto: "Formulario de contacto",
};

export const contactReceivedTemplate: TemplateDefinition<ContactReceivedVariables> = {
  id: "contact-received",
  name: "Contacto recibido (interno)",
  category: "internal",
  mandatory: true,
  schema: ContactReceivedVariablesSchema,
  sampleData: {
    recipientName: "Equipo de Atiende (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    contactName: "Fernanda Ibáñez (ejemplo)",
    contactEmail: "fernanda.ejemplo@empresa-demo.mx",
    contactPhone: "+52 55 0000 0000 (ejemplo)",
    message: "Nos interesa una demo para nuestra área de compras (mensaje de ejemplo).",
    receivedAtIso: "2026-09-06T20:00:00.000Z",
    source: "landing",
    adminUrl: "https://app.atiende.mx/interno/contactos/demo-001",
  },
  async render(vars) {
    const subject = `Nuevo contacto recibido: ${vars.contactName}`;
    const recibidoEl = formatFechaEs(vars.receivedAtIso);
    const rows = [
      { label: "Nombre", value: vars.contactName },
      { label: "Correo", value: vars.contactEmail },
      { label: "Origen", value: SOURCE_LABEL[vars.source] },
      { label: "Recibido", value: recibidoEl },
    ];
    if (vars.contactPhone) rows.splice(2, 0, { label: "Teléfono", value: vars.contactPhone });
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`${vars.contactName} dejó un mensaje desde ${SOURCE_LABEL[vars.source]}.`}
        reason="Te llegó este mensaje porque tienes acceso al buzón interno de contacto de Atiende."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
      >
        <Title>Nuevo contacto recibido</Title>
        <Paragraph>Alguien dejó un mensaje a través de {SOURCE_LABEL[vars.source].toLowerCase()}:</Paragraph>
        <DataTable rows={rows} />
        <Paragraph>"{vars.message}"</Paragraph>
        <CtaButton label="Ver y responder" href={vars.adminUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
