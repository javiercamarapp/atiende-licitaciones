import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, DataTable, Title } from "../../components/blocks";
import { BaseVariablesSchema } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

/**
 * REQ-181 (plantilla 6, "matching relevante"): el DIGESTO de varias
 * coincidencias en un solo correo, distinto de `new-tender-match.tsx`
 * (una alerta por convocatoria) — el motor de matching decide cuál mandar
 * según cuántas coincidencias haya en la ventana de agregación configurada.
 */
const TenderMatchSummarySchema = z.object({
  title: z.string().min(1),
  contractingEntity: z.string().min(1),
  matchScore: z.number().int().min(0).max(100),
});

export const TenderMatchDigestVariablesSchema = BaseVariablesSchema.extend({
  matches: z.array(TenderMatchSummarySchema).min(1),
  digestUrl: z.string().url(),
});

export type TenderMatchDigestVariables = z.infer<typeof TenderMatchDigestVariablesSchema>;

export const tenderMatchDigestTemplate: TemplateDefinition<TenderMatchDigestVariables> = {
  id: "tender-match-digest",
  name: "Matching relevante (varias convocatorias)",
  category: "tender_matches",
  mandatory: false,
  schema: TenderMatchDigestVariablesSchema,
  sampleData: {
    recipientName: "Roberto Salinas (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    preferencesUrl: "https://app.atiende.mx/preferencias?d=ejemplo&s=ejemplo",
    unsubscribeUrl: "https://app.atiende.mx/preferencias/baja?d=ejemplo&s=ejemplo",
    matches: [
      { title: "Suministro de equipo de cómputo para oficinas regionales (ejemplo)", contractingEntity: "Secretaría de Ejemplo del Estado (ejemplo)", matchScore: 92 },
      { title: "Mantenimiento de flotilla vehicular (ejemplo)", contractingEntity: "Municipio de Ejemplo (ejemplo)", matchScore: 81 },
      { title: "Servicio de limpieza para oficinas centrales (ejemplo)", contractingEntity: "Organismo Descentralizado Ejemplo (ejemplo)", matchScore: 76 },
    ],
    digestUrl: "https://app.atiende.mx/convocatorias?filtro=coincidencias",
  },
  async render(vars) {
    const n = vars.matches.length;
    // Asunto alineado a docs/investigacion/salida-promocion-referencias.md
    // §6.3 (REQ-181, plantilla 6).
    const subject = `${n} convocatoria${n === 1 ? "" : "s"} nueva${n === 1 ? "" : "s"} que coinciden con tu perfil`;
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`${n} convocatoria${n === 1 ? "" : "s"} nueva${n === 1 ? "" : "s"} por encima de tu umbral de relevancia.`}
        reason="Te llegó este mensaje porque tienes activas las alertas de coincidencia de convocatorias."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
        preferencesUrl={vars.preferencesUrl}
        unsubscribeUrl={vars.unsubscribeUrl}
      >
        <Title>Convocatorias que coinciden contigo</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>Encontramos {n} convocatoria{n === 1 ? "" : "s"} nueva{n === 1 ? "" : "s"} que coinciden con el perfil de tu empresa:</Paragraph>
        <DataTable
          rows={vars.matches.map((match) => ({
            label: match.title,
            value: `${match.contractingEntity} — ${match.matchScore}%`,
          }))}
        />
        <CtaButton label="Ver todas las coincidencias" href={vars.digestUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
