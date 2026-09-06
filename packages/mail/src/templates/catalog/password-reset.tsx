import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, Callout, Title } from "../../components/blocks";
import { BaseVariablesSchema } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const PasswordResetVariablesSchema = BaseVariablesSchema.extend({
  resetUrl: z.string().url(),
  expiresInMinutes: z.number().int().positive(),
  requestIp: z.string().optional(),
});

export type PasswordResetVariables = z.infer<typeof PasswordResetVariablesSchema>;

export const passwordResetTemplate: TemplateDefinition<PasswordResetVariables> = {
  id: "password-reset",
  name: "Restablecimiento de contraseña",
  category: "account_security",
  mandatory: true,
  schema: PasswordResetVariablesSchema,
  sampleData: {
    recipientName: "Luis Miguel Hernández (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    resetUrl: "https://app.atiende.mx/restablecer-contrasena?d=ejemplo&s=ejemplo",
    expiresInMinutes: 30,
    requestIp: "203.0.113.10 (ejemplo)",
  },
  async render(vars) {
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 3).
    const subject = "Recupera tu acceso a Atiende Licitaciones";
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`Pediste restablecer tu contraseña. El enlace vence en ${vars.expiresInMinutes} minutos.`}
        tone="atencion"
        reason="Te llegó este mensaje porque se solicitó restablecer la contraseña de esta cuenta."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
      >
        <Title>Restablece tu contraseña</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          Recibimos una solicitud para restablecer la contraseña de tu cuenta en Atiende Licitaciones. Si fuiste tú,
          confirma con el botón de abajo y elige una contraseña nueva.
        </Paragraph>
        <CtaButton label="Elegir nueva contraseña" href={vars.resetUrl} appUrl={vars.appUrl} showLiteralLink />
        <Callout>
          {vars.requestIp
            ? `La solicitud se originó desde ${vars.requestIp}. Este enlace vence en ${vars.expiresInMinutes} minutos y solo funciona una vez.`
            : `Este enlace vence en ${vars.expiresInMinutes} minutos y solo funciona una vez.`}{" "}
          Si no fuiste tú, tu contraseña actual sigue vigente: no tienes que hacer nada, pero avísanos si se repite.
        </Callout>
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
