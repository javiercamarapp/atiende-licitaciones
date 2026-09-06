import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Callout, Title } from "../../components/blocks";
import { BaseVariablesSchema } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const OrganizationInviteVariablesSchema = BaseVariablesSchema.extend({
  organizationName: z.string().min(1),
  inviterName: z.string().min(1),
  roleLabel: z.string().min(1),
  inviteUrl: z.string().url(),
  expiresInMinutes: z.number().int().positive(),
});

export type OrganizationInviteVariables = z.infer<typeof OrganizationInviteVariablesSchema>;

export const organizationInviteTemplate: TemplateDefinition<OrganizationInviteVariables> = {
  id: "organization-invite",
  name: "Invitación a organización",
  category: "account_security",
  mandatory: true,
  schema: OrganizationInviteVariablesSchema,
  sampleData: {
    recipientName: "Jorge Alberto Ruiz (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    organizationName: "Constructora Ejemplo S.A. de C.V. (ejemplo)",
    inviterName: "Ana Torres (ejemplo)",
    roleLabel: "Operador de licitaciones",
    inviteUrl: "https://app.atiende.mx/invitaciones/aceptar?d=ejemplo&s=ejemplo",
    expiresInMinutes: 60 * 24 * 7,
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 2).
    const subject = `Te dieron acceso a ${vars.organizationName} en Atiende Licitaciones`;
    const days = Math.round(vars.expiresInMinutes / (60 * 24));
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`Únete a ${vars.organizationName} en Atiende Licitaciones. La invitación vence en ${days} días.`}
        reason={`Te llegó este mensaje porque ${vars.inviterName} te invitó a colaborar en ${vars.organizationName}.`}
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
      >
        <Title>Te invitaron a colaborar</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          {vars.inviterName} te invitó a unirte al equipo de {vars.organizationName} en Atiende Licitaciones, con el
          rol de {vars.roleLabel}. Desde ahí vas a poder ver convocatorias, expedientes y aprobaciones de la
          organización.
        </Paragraph>
        <DataTable
          rows={[
            { label: "Organización", value: vars.organizationName },
            { label: "Invitado por", value: vars.inviterName },
            { label: "Rol asignado", value: vars.roleLabel },
          ]}
        />
        <CtaButton label="Aceptar invitación" href={vars.inviteUrl} appUrl={vars.appUrl} showLiteralLink />
        <Callout>
          Esta invitación vence en {days} días. Si no esperabas este correo, puedes ignorarlo: no se te agrega a
          ninguna organización sin que aceptes.
        </Callout>
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
