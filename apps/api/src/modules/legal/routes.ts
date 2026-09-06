/**
 * REQ-119/REQ-131: aviso de privacidad, servido versionado desde un
 * archivo Markdown con "front matter" (metadatos), no redactado de
 * memoria en el código -- el contenido y sus metadatos (ley aplicable,
 * responsable, autoridad supervisora) viven en
 * `apps/api/docs/legal/privacy-notice.md`, la misma fuente que
 * `docs/legal/verificacion-legal.md` respalda. Ruta PÚBLICA (sin
 * `app.authenticate`): un aviso de privacidad debe poder consultarse antes
 * de crear una cuenta.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { privacyNoticeResponseSchema } from './schemas.js';

const PRIVACY_NOTICE_PATH = fileURLToPath(new URL('../../../docs/legal/privacy-notice.md', import.meta.url));

interface ParsedPrivacyNotice {
  version: number;
  publishedAt: string;
  status: 'borrador_pendiente_validacion_juridica';
  responsible: string;
  supervisoryAuthority: string;
  applicableLaw: string;
  sourceDocument: string;
  contentMarkdown: string;
}

/**
 * Parser mínimo de "front matter" (delimitado por `---`), suficiente para
 * este único archivo controlado internamente -- deliberadamente no se
 * agrega una dependencia externa (gray-matter/js-yaml) solo para esto.
 * Cada línea del front matter es `clave: valor` (sin anidamiento, sin
 * listas); el resto del archivo, tal cual, es `contentMarkdown`.
 */
function parsePrivacyNotice(raw: string): ParsedPrivacyNotice {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`privacy-notice.md sin front matter válido (se esperaba un bloque "---...---" al inicio): ${PRIVACY_NOTICE_PATH}`);
  }
  const [, frontMatterRaw, body] = match;
  const fields: Record<string, string> = {};
  for (const line of frontMatterRaw.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    fields[key] = value;
  }

  const required = ['version', 'publishedAt', 'status', 'responsible', 'supervisoryAuthority', 'applicableLaw', 'sourceDocument'] as const;
  for (const key of required) {
    if (!fields[key]) {
      throw new Error(`privacy-notice.md: falta el campo obligatorio "${key}" en el front matter.`);
    }
  }
  if (fields.status !== 'borrador_pendiente_validacion_juridica') {
    throw new Error(`privacy-notice.md: "status" inesperado ("${fields.status}") -- este documento debe declararse explícitamente como borrador hasta que un abogado lo valide.`);
  }

  return {
    version: Number(fields.version),
    publishedAt: fields.publishedAt,
    status: 'borrador_pendiente_validacion_juridica',
    responsible: fields.responsible,
    supervisoryAuthority: fields.supervisoryAuthority,
    applicableLaw: fields.applicableLaw,
    sourceDocument: fields.sourceDocument,
    contentMarkdown: body.trim(),
  };
}

export async function legalRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/legal/privacy-notice',
    {
      schema: {
        description:
          'Aviso de privacidad (REQ-119/REQ-131), versionado desde apps/api/docs/legal/privacy-notice.md. Ruta pública, sin autenticación -- debe poder consultarse antes de crear una cuenta. Marcado explícitamente como borrador pendiente de validación jurídica hasta que un abogado mexicano lo confirme.',
        response: { 200: privacyNoticeResponseSchema },
      },
    },
    async () => {
      // Se relee del disco en cada request (documento pequeño, cambia con
      // poca frecuencia): evita servir una versión cacheada obsoleta tras
      // desplegar una actualización del aviso sin reiniciar el proceso.
      const raw = readFileSync(PRIVACY_NOTICE_PATH, 'utf8');
      return parsePrivacyNotice(raw);
    }
  );
}

export { parsePrivacyNotice };
