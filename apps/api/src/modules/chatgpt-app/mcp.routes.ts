/**
 * REQ-067 — superficie MCP (Model Context Protocol) que una ChatGPT App
 * (Apps SDK) consumiría: `POST /chatgpt-app/mcp` (JSON-RPC 2.0:
 * `initialize`, `tools/list`, `tools/call`, `resources/list`,
 * `resources/read`) y `GET /chatgpt-app/manifest.json` (descriptor público
 * del servidor).
 *
 * El allowlist de herramientas y la guarda anti-filtración de documentos
 * firmables son REGLA DE NEGOCIO en `@atiende/expediente`
 * (`packages/expediente/src/chatgpt-app.ts`, probada de forma aislada);
 * este archivo es el único que las cablea contra Postgres real
 * (`tools.ts`) y las expone por HTTP.
 *
 * Autenticación/tenant: reutiliza EXACTAMENTE `app.authenticate` +
 * `app.requireOrg` (el mismo JWT bearer + `X-Org-Id` que el resto de
 * `apps/api`) — nunca un mecanismo de autenticación paralelo. Límite
 * honesto explícito (docs/ACEPTACION.md REQ-067,
 * `verificado_contra_real=false` para esta parte, ver también el
 * encabezado de `packages/expediente/src/chatgpt-app.ts`): esto NO es el
 * flujo OAuth 2.1 con registro dinámico de cliente que el conector de
 * ChatGPT completaría de verdad contra un MCP público (spec de
 * autorización de MCP, RFC 8414/9728 + PKCE) — ese registro depende de
 * publicar la app en el directorio de OpenAI (credenciales/aprobación que
 * este entorno no tiene; NO es B-02 ni B-04, es un tercer bloqueo externo
 * distinto, documentado aquí y en docs/ACEPTACION.md). Lo que SÍ es real y
 * probado: el protocolo JSON-RPC de MCP, el allowlist de herramientas de
 * solo lectura (con su doble guarda: allowlist de NOMBRE + escaneo
 * defensivo de SALIDA), las consultas reales a la base de datos con
 * aislamiento de tenant, y los widgets `text/html+skybridge`.
 *
 * Regla dura de esta ruta, verificada en
 * `test/chatgpt-app-widget.test.ts` (adversarial): `tools/call` SOLO
 * ejecuta un nombre de herramienta presente en
 * `CHATGPT_APP_TOOL_DEFINITIONS` (`assertAllowedChatGptAppTool`,
 * comparación exacta de string). Cualquier otro nombre — incluidos
 * `aprobar_propuesta`, `generar_paquete`, `fijar_precio_final`,
 * `emitir_paquete_para_aprobacion` (las herramientas de escritura que el
 * blueprint reserva a otros canales) o cualquier variante — se rechaza
 * ANTES de abrir transacción alguna. Además, la salida de CADA llamada
 * exitosa pasa por `assertNoFirmableDocumentInToolOutput` (defensa en
 * profundidad, no el control principal) antes de responder.
 */
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { DbExecutor } from '@atiende/db';
import {
  CHATGPT_APP_TOOL_DEFINITIONS,
  ChatGptAppToolNotAllowedError,
  assertAllowedChatGptAppTool,
  assertNoFirmableDocumentInToolOutput,
  type ChatGptAppToolName,
} from '@atiende/expediente';
import {
  withTx,
  listTenders,
  listTendersInputSchema,
  getTender,
  getTenderInputSchema,
  getApprovalStatus,
  getApprovalStatusInputSchema,
  getComplianceMatrix,
  getComplianceMatrixInputSchema,
  ChatGptAppToolError,
} from './tools.js';
import {
  WIDGET_RESOURCES,
  findWidgetResource,
  CONVOCATORIAS_WIDGET_URI,
  TENDER_WIDGET_URI,
  APROBACION_WIDGET_URI,
  MATRIZ_WIDGET_URI,
} from './widgets.js';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'atiende-licitaciones-chatgpt-app';
const SERVER_VERSION = '0.1.0';

/** Todas de solo lectura por construcción: este archivo nunca registra una herramienta que no pase por `run` sin escribir en la base de datos. */
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Mapa NOMBRE -> (ejecutor real, plantilla de widget). El allowlist de nombres vive en `@atiende/expediente`; aquí solo se cablea cada nombre YA aprobado contra su implementación de Postgres. */
const TOOL_RUNNERS: Record<ChatGptAppToolName, { run: (tx: DbExecutor, orgId: string, args: unknown) => Promise<unknown>; widgetUri: string }> = {
  list_tenders: { run: (tx, orgId, args) => listTenders(tx, orgId, listTendersInputSchema.parse(args ?? {})), widgetUri: CONVOCATORIAS_WIDGET_URI },
  get_tender: { run: (tx, orgId, args) => getTender(tx, orgId, getTenderInputSchema.parse(args ?? {})), widgetUri: TENDER_WIDGET_URI },
  get_approval_status: { run: (tx, orgId, args) => getApprovalStatus(tx, orgId, getApprovalStatusInputSchema.parse(args ?? {})), widgetUri: APROBACION_WIDGET_URI },
  get_compliance_matrix: { run: (tx, orgId, args) => getComplianceMatrix(tx, orgId, getComplianceMatrixInputSchema.parse(args ?? {})), widgetUri: MATRIZ_WIDGET_URI },
};

const jsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}
interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

const JSON_RPC_ERROR = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  TOOL_NOT_ALLOWED: -32001,
  RESOURCE_NOT_FOUND: -32002,
} as const;

function ok(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}
function fail(id: string | number | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function chatGptAppRoutes(app: FastifyInstance): Promise<void> {
  // GET /chatgpt-app/manifest.json — descriptor público (sin secretos,
  // sin datos de tenant): documenta el endpoint MCP y el allowlist de
  // herramientas para quien configure el conector del lado de ChatGPT.
  // `API_PUBLIC_URL` es OPCIONAL a propósito (ver config.ts): esta API no
  // conoce su propia URL pública salvo que se le diga explícitamente
  // (Vercel/serverless no la expone de forma fiable) -- sin configurarla,
  // el manifiesto declara el endpoint como ruta RELATIVA y lo dice, en vez
  // de fabricar un host que podría ser el equivocado.
  app.get('/manifest.json', { schema: { hide: true } }, async () => {
    const base = app.config.apiPublicUrl;
    return {
      schema_version: 'v1',
      name_for_human: 'Atiende Licitaciones',
      name_for_model: 'atiende_licitaciones',
      description_for_human:
        'Descubre licitaciones de gobierno de México que coinciden con tu empresa y consulta el estado de aprobación y el semáforo de cumplimiento. Solo lectura: nunca exporta documentos firmables ni permite una segunda firma.',
      description_for_model:
        'Herramientas de solo lectura sobre las convocatorias y el expediente de la organización del usuario autenticado. Nunca fijes precio, nunca generes ni descargues el paquete de propuesta, nunca sugieras compartir datos entre organizaciones distintas.',
      mcp_endpoint: base ? `${base}/chatgpt-app/mcp` : '/chatgpt-app/mcp',
      mcp_endpoint_is_absolute: base !== undefined && base !== null,
      auth: {
        type: 'bearer',
        note:
          'Bearer <access token> emitido por POST /auth/login, más el encabezado X-Org-Id. No implementa (todavía) el flujo OAuth 2.1 con registro dinámico de cliente de la especificación de autorización de MCP -- ver comentario de cabecera en mcp.routes.ts.',
      },
      tools: CHATGPT_APP_TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, readOnly: true })),
    };
  });

  app.post('/mcp', { preHandler: [app.authenticate, app.requireOrg], schema: { hide: true } }, async (request, reply) => {
    const orgId = request.orgId!;
    const userId = request.userId;

    const parsed = jsonRpcEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(200);
      return fail(null, JSON_RPC_ERROR.INVALID_REQUEST, 'Cuerpo JSON-RPC 2.0 inválido: se requieren "jsonrpc":"2.0" y "method".');
    }
    const { id, method, params } = parsed.data;
    const requestId = id ?? null;
    // Notificación (sin `id`, p. ej. "notifications/initialized"): el
    // protocolo MCP no espera respuesta con cuerpo -- 202 sin contenido.
    const isNotification = id === undefined;

    if (method === 'initialize') {
      const result = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {}, resources: {} },
      };
      if (isNotification) return reply.code(202).send();
      return ok(requestId, result);
    }

    if (method === 'tools/list') {
      const result = {
        tools: CHATGPT_APP_TOOL_DEFINITIONS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: READ_ONLY_ANNOTATIONS,
          _meta: { 'openai/outputTemplate': TOOL_RUNNERS[t.name].widgetUri },
        })),
      };
      if (isNotification) return reply.code(202).send();
      return ok(requestId, result);
    }

    if (method === 'tools/call') {
      const callParams = params as { name?: unknown; arguments?: unknown } | undefined;
      const name = callParams?.name;
      try {
        // Guarda dura (@atiende/expediente): comparación EXACTA de string
        // contra el allowlist -- rechaza ANTES de abrir transacción.
        assertAllowedChatGptAppTool(typeof name === 'string' ? name : String(name));
      } catch (err) {
        if (err instanceof ChatGptAppToolNotAllowedError) {
          if (isNotification) return reply.code(202).send();
          return fail(requestId, JSON_RPC_ERROR.TOOL_NOT_ALLOWED, err.message);
        }
        throw err;
      }
      const tool = TOOL_RUNNERS[name as ChatGptAppToolName];
      try {
        const output = await withTx(app.db, orgId, userId, (tx) => tool.run(tx, orgId, callParams?.arguments));
        // Defensa en profundidad (no el control principal, ver cabecera):
        // aunque cada función de tools.ts ya proyecta solo campos seguros,
        // esto falla cerrado si algún cambio futuro reintrodujera por
        // error un campo documental/firmable.
        assertNoFirmableDocumentInToolOutput(output);
        const result = {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
          isError: false,
          _meta: { 'openai/outputTemplate': tool.widgetUri },
        };
        if (isNotification) return reply.code(202).send();
        return ok(requestId, result);
      } catch (err) {
        // Errores de negocio/validación (convocatoria inexistente,
        // argumentos inválidos) se devuelven como CallToolResult con
        // isError:true -- nunca como un 500 sin explicación, y nunca
        // fabricando un resultado "vacío pero exitoso".
        const message =
          err instanceof ChatGptAppToolError
            ? err.message
            : err instanceof ZodError
              ? `Argumentos inválidos: ${err.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`
              : (() => {
                  throw err;
                })();
        const result = { content: [{ type: 'text', text: message }], isError: true };
        if (isNotification) return reply.code(202).send();
        return ok(requestId, result);
      }
    }

    if (method === 'resources/list') {
      const result = { resources: WIDGET_RESOURCES.map(({ uri, name: resourceName, description, mimeType }) => ({ uri, name: resourceName, description, mimeType })) };
      if (isNotification) return reply.code(202).send();
      return ok(requestId, result);
    }

    if (method === 'resources/read') {
      const readParams = params as { uri?: unknown } | undefined;
      const uri = typeof readParams?.uri === 'string' ? readParams.uri : undefined;
      const widget = uri ? findWidgetResource(uri) : undefined;
      if (!widget) {
        if (isNotification) return reply.code(202).send();
        return fail(requestId, JSON_RPC_ERROR.RESOURCE_NOT_FOUND, `Recurso no encontrado: "${String(uri)}"`);
      }
      const result = { contents: [{ uri: widget.uri, mimeType: widget.mimeType, text: widget.html }] };
      if (isNotification) return reply.code(202).send();
      return ok(requestId, result);
    }

    // Cualquier notificación desconocida se ignora silenciosamente (así lo
    // exige el protocolo: un servidor MCP nunca falla por una notificación
    // que no reconoce). Un método desconocido CON id sí es un error.
    if (isNotification) return reply.code(202).send();
    return fail(requestId, JSON_RPC_ERROR.METHOD_NOT_FOUND, `Método no soportado: "${method}"`);
  });
}
