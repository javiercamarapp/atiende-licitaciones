import { z } from 'zod';

export const privacyNoticeResponseSchema = z.object({
  version: z.number(),
  publishedAt: z.string(),
  /** Siempre 'borrador_pendiente_validacion_juridica' mientras ningún abogado mexicano haya validado el texto (ver README/docs/legal/verificacion-legal.md). */
  status: z.literal('borrador_pendiente_validacion_juridica'),
  responsible: z.string(),
  supervisoryAuthority: z.string(),
  applicableLaw: z.string(),
  sourceDocument: z.string(),
  /** Cuerpo completo del aviso, en Markdown, tal cual se sirve/renderiza. */
  contentMarkdown: z.string(),
});
