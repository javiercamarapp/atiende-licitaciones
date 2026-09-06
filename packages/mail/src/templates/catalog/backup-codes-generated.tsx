import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, BackupCodesGrid, Callout, Title } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const BackupCodesGeneratedVariablesSchema = BaseVariablesSchema.extend({
  codes: z.array(z.string().min(4)).min(1),
  generatedAtIso: z.string().min(1),
});

export type BackupCodesGeneratedVariables = z.infer<typeof BackupCodesGeneratedVariablesSchema>;

export const backupCodesGeneratedTemplate: TemplateDefinition<BackupCodesGeneratedVariables> = {
  id: "backup-codes-generated",
  name: "Códigos de respaldo generados",
  category: "account_security",
  mandatory: true,
  schema: BackupCodesGeneratedVariablesSchema,
  sampleData: {
    recipientName: "Paola Sánchez (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    codes: ["7K2X-9QWT", "M4RT-2ZPL", "B9GH-6VNQ", "L1XC-8FDR", "Q7WE-3TYU", "A2SD-5FGH", "Z9XC-1VBN", "P6OI-4UYT"],
    generatedAtIso: "2026-09-06T18:31:00.000Z",
  },
  async render(vars) {
    const subject = "Tus códigos de respaldo de verificación en dos pasos";
    const fecha = formatFechaEs(vars.generatedAtIso);
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader="Guarda estos códigos en un lugar seguro: cada uno funciona una sola vez."
        reason="Te llegó este mensaje porque generaste códigos de respaldo para tu verificación en dos pasos."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
      >
        <Title>Tus códigos de respaldo</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          Generaste {vars.codes.length} códigos de respaldo el {fecha}. Úsalos para entrar a tu cuenta si pierdes
          acceso a tu método de verificación en dos pasos habitual. Cada código funciona una sola vez.
        </Paragraph>
        <BackupCodesGrid codes={vars.codes} />
        <Callout>
          Guárdalos en un lugar seguro fuera de tu correo (un gestor de contraseñas, por ejemplo). Generar códigos
          nuevos invalida automáticamente los anteriores. Si tú no hiciste esto, cambia tu contraseña y escríbenos a{" "}
          {vars.supportEmail}.
        </Callout>
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
