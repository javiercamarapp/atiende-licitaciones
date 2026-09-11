/**
 * REQ-067 — reglas de negocio de la superficie de solo lectura para un
 * "ChatGPT App" (OpenAI Apps SDK, servidor MCP) sobre el expediente de
 * licitaciones. BLUEPRINT-LICITACIONES.pdf L839-843/L945-948: el widget
 * SOLO puede invocar herramientas de LECTURA (nunca segunda firma) y NUNCA
 * debe exponer un documento firmable (paquete final, contrato firmado,
 * evidencia con PDF).
 *
 * Esta lógica vive en `@atiende/expediente` (no solo en la ruta HTTP de
 * `apps/api`) para que sea una regla de negocio real, probada de forma
 * aislada — mismo patrón que `approval-workflow.ts` con sus roles
 * autorizados. `apps/api/src/modules/chatgpt-app` es el único lugar que la
 * invoca, cableándola contra Postgres real.
 *
 * verificado_contra_real=false: la lista de herramientas y el filtro de
 * salida están construidos contra el protocolo MCP y el Apps SDK
 * documentados públicamente por OpenAI, pero NUNCA se han probado contra un
 * cliente real de ChatGPT (requeriría una App registrada en el portal de
 * desarrolladores de OpenAI, credencial que no existe en este entorno) ni
 * contra un authorization server MCP real (RFC 8414/9728 + PKCE, pendiente
 * — ver docs/investigacion/salida-promocion-referencias.md L74-77). Ver
 * docs/REQUISITOS.md (REQ-067) para el estado exacto.
 */

/** Único conjunto de herramientas que el ChatGPT App puede invocar — todas de lectura, ninguna de aprobación/firma/exportación. */
export type ChatGptAppToolName = "list_tenders" | "get_tender" | "get_approval_status" | "get_compliance_matrix";

export interface ChatGptAppToolDefinition {
  name: ChatGptAppToolName;
  title: string;
  description: string;
  /** JSON Schema (no Zod): es lo que el protocolo MCP espera en `tools/list`. */
  inputSchema: Record<string, unknown>;
}

export const CHATGPT_APP_TOOL_DEFINITIONS: readonly ChatGptAppToolDefinition[] = [
  {
    name: "list_tenders",
    title: "Listar convocatorias",
    description:
      "Lista de solo lectura de las convocatorias (licitaciones) de la organización conectada, sin documentos ni datos firmables.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", description: "Filtro opcional por estado de la convocatoria." } },
      additionalProperties: false,
    },
  },
  {
    name: "get_tender",
    title: "Ver convocatoria",
    description: "Detalle de solo lectura de una convocatoria por id, sin documentos ni datos firmables.",
    inputSchema: {
      type: "object",
      properties: { tenderId: { type: "string", format: "uuid" } },
      required: ["tenderId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_approval_status",
    title: "Ver estado de aprobación",
    description:
      "Estado de solo lectura del flujo de primera aprobación del expediente (borrador/en_revision/aprobado) y sus comentarios. Nunca expone el contenido del expediente, el paquete final, el contrato ni permite aprobar, firmar o exportar nada.",
    inputSchema: {
      type: "object",
      properties: { tenderId: { type: "string", format: "uuid" } },
      required: ["tenderId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_compliance_matrix",
    title: "Ver matriz de cumplimiento",
    description:
      "Semáforo de solo lectura de la matriz de cumplimiento (verde/ambar/rojo por requisito) de una convocatoria. Nunca incluye la referencia de evidencia interna ni ningún documento — solo el resultado y una nota breve por requisito.",
    inputSchema: {
      type: "object",
      properties: { tenderId: { type: "string", format: "uuid" } },
      required: ["tenderId"],
      additionalProperties: false,
    },
  },
] as const;

const ALLOWED_TOOL_NAMES = new Set<string>(CHATGPT_APP_TOOL_DEFINITIONS.map((t) => t.name));

export class ChatGptAppToolNotAllowedError extends Error {
  constructor(public readonly requestedName: string) {
    super(
      `Herramienta "${requestedName}" no está permitida en el ChatGPT App de licitaciones: solo se exponen herramientas de lectura (${[...ALLOWED_TOOL_NAMES].join(", ")}). Nunca se expone una acción de aprobación, firma o exportación de documentos.`
    );
    this.name = "ChatGptAppToolNotAllowedError";
  }
}

/** Guarda dura: cualquier nombre de herramienta fuera del allowlist se rechaza aquí, antes de tocar la base de datos. */
export function assertAllowedChatGptAppTool(name: string): asserts name is ChatGptAppToolName {
  if (!ALLOWED_TOOL_NAMES.has(name)) {
    throw new ChatGptAppToolNotAllowedError(name);
  }
}

export class ChatGptAppFirmableDocumentLeakError extends Error {
  constructor(public readonly path: string) {
    super(
      `Bloqueado por REQ-067: la salida de una herramienta de LECTURA del ChatGPT App intentaba exponer un dato firmable/documental en "${path}". Esto nunca debería ocurrir — es una guarda de última línea, no el control principal.`
    );
    this.name = "ChatGptAppFirmableDocumentLeakError";
  }
}

// Sub-cadenas (normalizadas: minúsculas, sin separadores) de nombres de
// campo que jamás deben aparecer en la salida de una herramienta de este
// ChatGPT App — documentos, paquetes, contratos, firmantes o adjuntos.
const FORBIDDEN_KEY_SUBSTRINGS = [
  "documenturl",
  "documentid",
  "packageurl",
  "packageid",
  "signedpdf",
  "signatureurl",
  "signaturedata",
  "contracturl",
  "contractfile",
  "downloadurl",
  "fileurl",
  "filepath",
  "storagepath",
  "s3key",
  "objectkey",
  "signername",
  "signerid",
  "signeremail",
  "evidencedocid",
  "evidenceref",
  "pdfurl",
  "pdfbase64",
  "attachment",
] as const;

// Valores que "huelen" a ruta de archivo firmable, aunque el nombre del
// campo no esté en la lista de arriba (defensa en profundidad).
const FORBIDDEN_VALUE_PATTERN = /\.(pdf|docx?|zip)(\?|#|$)/i;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Escaneo recursivo defensivo de la salida de una herramienta antes de que
 * salga hacia el cliente MCP: incluso si un cambio futuro agregara por
 * error un campo documental a una herramienta de LECTURA, esto falla
 * cerrado en vez de filtrar el dato. No sustituye el diseño explícito de
 * cada herramienta (que ya proyecta solo los campos permitidos) — es la
 * última línea, probada por separado (adversarial).
 */
export function assertNoFirmableDocumentInToolOutput(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE_PATTERN.test(value)) {
      throw new ChatGptAppFirmableDocumentLeakError(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoFirmableDocumentInToolOutput(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeKey(key);
      if (FORBIDDEN_KEY_SUBSTRINGS.some((needle) => normalized.includes(needle))) {
        throw new ChatGptAppFirmableDocumentLeakError(`${path}.${key}`);
      }
      assertNoFirmableDocumentInToolOutput(val, `${path}.${key}`);
    }
  }
}
