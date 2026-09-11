import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';
import { CHATGPT_APP_TOOL_DEFINITIONS } from '@atiende/expediente';

/**
 * REQ-067 — ChatGPT App (Apps SDK / MCP): "Widget renderiza solo
 * `toolOutput` de lectura; `callTool` restringido" (docs/REQUISITOS.md);
 * "El widget de ChatGPT App solo permite `callTool` de lectura; no expone
 * documentos firmables" (docs/ACEPTACION.md, adversarial).
 *
 * El allowlist de nombres y la guarda anti-filtración de documentos
 * firmables son reglas de negocio probadas de forma AISLADA en
 * `packages/expediente/test/chatgpt-app.test.ts`; esta suite prueba la
 * superficie HTTP/JSON-RPC real cableada contra Postgres
 * (`modules/chatgpt-app/`): protocolo MCP, aislamiento de tenant real (dos
 * organizaciones), y los mismos ataques a nivel de transporte (nombre de
 * herramienta fuera de allowlist, cross-tenant, argumentos inválidos, URI
 * de recurso arbitraria, JSON-RPC malformado).
 */

async function createTender(app: FastifyInstance, orgId: string, externalId: string, title = 'Servicio de limpieza'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [{ source: 'compras-mx', externalId, title, sourceVersion: 'v1', budgetAmount: 250000, submissionDeadline: '2099-01-01T00:00:00Z' }],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

function rpc(method: string, params?: unknown, id: string | number | null = 1) {
  return { jsonrpc: '2.0' as const, id, method, params };
}

describe('REQ-067 — ChatGPT App widget (MCP de solo lectura)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('GET /chatgpt-app/manifest.json es público, describe el endpoint y solo lista herramientas de lectura', async () => {
    const res = await app.inject({ method: 'GET', url: '/chatgpt-app/manifest.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.auth.type).toBe('bearer');
    expect(body.mcp_endpoint).toContain('/chatgpt-app/mcp');
    // Sin API_PUBLIC_URL configurada (no lo está en el entorno de pruebas), el endpoint debe ser relativo, nunca inventado.
    expect(body.mcp_endpoint_is_absolute).toBe(false);
    expect(body.tools.length).toBe(CHATGPT_APP_TOOL_DEFINITIONS.length);
    expect(body.tools.every((t: any) => t.readOnly === true)).toBe(true);
    const bodyText = JSON.stringify(body).toLowerCase();
    expect(bodyText).not.toMatch(/aprobar_propuesta|generar_paquete|fijar_precio|sign_contract|export_package/);
  });

  it('POST /chatgpt-app/mcp sin Authorization se rechaza (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/chatgpt-app/mcp', payload: rpc('tools/list') });
    expect(res.statusCode).toBe(401);
  });

  it('POST /chatgpt-app/mcp con token válido pero sin X-Org-Id se rechaza (403)', async () => {
    const owner = await registerAndLogin(app, 'mcp-owner-noorg@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/chatgpt-app/mcp',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: rpc('tools/list'),
    });
    expect(res.statusCode).toBe(403);
  });

  describe('con sesión autenticada y organización', () => {
    async function setup(emailPrefix: string) {
      const owner = await registerAndLogin(app, `${emailPrefix}@example.com`);
      const org = await createOrgFor(app, owner, `Org ${emailPrefix}`, `org-${emailPrefix}`.toLowerCase());
      const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
      return { owner, org, headers };
    }

    it('initialize responde protocolVersion y serverInfo', async () => {
      const { headers } = await setup('mcp-init');
      const res = await app.inject({ method: 'POST', url: '/chatgpt-app/mcp', headers, payload: rpc('initialize', {}) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.serverInfo.name).toBe('atiende-licitaciones-chatgpt-app');
      expect(typeof body.result.protocolVersion).toBe('string');
    });

    it('tools/list devuelve exactamente el allowlist de lectura de @atiende/expediente, todas readOnlyHint y con outputTemplate declarado', async () => {
      const { headers } = await setup('mcp-list');
      const res = await app.inject({ method: 'POST', url: '/chatgpt-app/mcp', headers, payload: rpc('tools/list') });
      const tools = res.json().result.tools;
      expect(tools.length).toBe(CHATGPT_APP_TOOL_DEFINITIONS.length);
      expect(tools.map((t: any) => t.name).sort()).toEqual(CHATGPT_APP_TOOL_DEFINITIONS.map((t) => t.name).sort());
      for (const t of tools) {
        expect(t.annotations.readOnlyHint).toBe(true);
        expect(t.annotations.destructiveHint).toBe(false);
        expect(t._meta['openai/outputTemplate']).toMatch(/^ui:\/\/chatgpt-app\//);
      }
    });

    it('resources/list y resources/read devuelven widgets text/html+skybridge autocontenidos (uno por herramienta)', async () => {
      const { headers } = await setup('mcp-res');
      const list = await app.inject({ method: 'POST', url: '/chatgpt-app/mcp', headers, payload: rpc('resources/list') });
      const resources = list.json().result.resources;
      expect(resources.length).toBe(CHATGPT_APP_TOOL_DEFINITIONS.length);
      for (const r of resources) {
        expect(r.mimeType).toBe('text/html+skybridge');
        const read = await app.inject({ method: 'POST', url: '/chatgpt-app/mcp', headers, payload: rpc('resources/read', { uri: r.uri }) });
        expect(read.statusCode).toBe(200);
        const html: string = read.json().result.contents[0].text;
        // Regla dura (ver widgets.ts): SOLO lee window.openai.toolOutput,
        // nunca llama a otra herramienta ni carga nada externo.
        expect(html).toContain('window.openai');
        expect(html).toContain('toolOutput');
        expect(html).not.toMatch(/callTool\s*\(/);
        expect(html).not.toMatch(/<script[^>]+src=/i);
        expect(html).not.toMatch(/<link[^>]+href=/i);
        expect(html).not.toMatch(/fetch\s*\(/);
      }
    });

    it('list_tenders devuelve solo las convocatorias de la organización del token (aislamiento de tenant real)', async () => {
      const a = await setup('mcp-tenderA');
      const b = await setup('mcp-tenderB');
      await createTender(app, a.org.id, 'mcp-a-001', 'Convocatoria de A');
      await createTender(app, b.org.id, 'mcp-b-001', 'Convocatoria de B');

      const res = await app.inject({
        method: 'POST',
        url: '/chatgpt-app/mcp',
        headers: a.headers,
        payload: rpc('tools/call', { name: 'list_tenders', arguments: {} }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.isError).toBe(false);
      const output = body.result.structuredContent;
      expect(output.items.length).toBe(1);
      expect(output.items[0].title).toBe('Convocatoria de A');
      // Adversarial: ni el id ni el título de la convocatoria de B aparecen en ninguna parte de la respuesta.
      expect(JSON.stringify(body)).not.toContain('Convocatoria de B');
    });

    it('get_tender devuelve el detalle de una convocatoria propia', async () => {
      const { headers, org } = await setup('mcp-get-tender');
      const tenderId = await createTender(app, org.id, 'mcp-get-001', 'Suministro de papelería');
      const res = await app.inject({
        method: 'POST',
        url: '/chatgpt-app/mcp',
        headers,
        payload: rpc('tools/call', { name: 'get_tender', arguments: { tenderId } }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.isError).toBe(false);
      expect(body.result.structuredContent.title).toBe('Suministro de papelería');
    });

    it('get_approval_status refleja el ApprovalWorkflow real (borrador sin expediente, nunca "aprobado" por defecto)', async () => {
      const { headers, org } = await setup('mcp-approval');
      const tenderId = await createTender(app, org.id, 'mcp-approval-001');
      const res = await app.inject({
        method: 'POST',
        url: '/chatgpt-app/mcp',
        headers,
        payload: rpc('tools/call', { name: 'get_approval_status', arguments: { tenderId } }),
      });
      expect(res.statusCode).toBe(200);
      const output = res.json().result.structuredContent;
      expect(output.state).toBe('borrador');
      expect(output.approvals).toEqual([]);
      const raw = JSON.stringify(res.json());
      for (const forbidden of ['approvedBy"', 'inputsHash']) {
        expect(raw).not.toContain(forbidden);
      }
    });

    it('get_compliance_matrix refleja el checklist real persistido y nunca incluye evidenceRef ni enlaces de descarga', async () => {
      const { headers, org } = await setup('mcp-matriz');
      const tenderId = await createTender(app, org.id, 'mcp-matriz-001');
      await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });
      const run = await app.inject({
        method: 'POST',
        url: `/expediente/tenders/${tenderId}/checklist/run`,
        headers,
        payload: { files: [], formatLimits: { allowedExtensions: ['pdf'], maxFileSizeBytes: 5_000_000, maxUploadSlots: 5 } },
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().overallStatus).toBe('rojo');

      const res = await app.inject({
        method: 'POST',
        url: '/chatgpt-app/mcp',
        headers,
        payload: rpc('tools/call', { name: 'get_compliance_matrix', arguments: { tenderId } }),
      });
      expect(res.statusCode).toBe(200);
      const output = res.json().result.structuredContent;
      expect(output.overallStatus).toBe('rojo');
      expect(output.items.length).toBe(7);

      // Adversarial: nunca `evidenceRef` (referencia interna de evidencia)
      // ni un valor que "huela" a documento firmable (ruta a .pdf/.docx/.zip).
      // Nota: la dimensión real "firmas" del checklist SÍ menciona la
      // palabra "firma" en su nota de texto libre ("todas las firmas
      // requeridas fueron confirmadas...") -- eso es vocabulario de
      // negocio legítimo, no una filtración; la guarda real es sobre
      // NOMBRES DE CAMPO y RUTAS DE ARCHIVO, igual que
      // `assertNoFirmableDocumentInToolOutput` en `@atiende/expediente`.
      const raw = JSON.stringify(res.json()).toLowerCase();
      expect(raw).not.toContain('evidenceref');
      expect(raw).not.toMatch(/\.(pdf|docx?|zip)(["'?#]|\b)/);
      for (const forbiddenField of ['downloadurl', 'manifesthash', 'signatureurl', 'signeddata', 'packageid', 'documenturl']) {
        expect(raw).not.toContain(forbiddenField);
      }
    });

    describe('adversarial', () => {
      it('tools/call con un nombre de herramienta de escritura fuera del allowlist se rechaza sin tocar la base de datos', async () => {
        const { headers, org } = await setup('mcp-adv-write');
        for (const forbiddenName of ['aprobar_propuesta', 'generar_paquete', 'fijar_precio_final', 'sign_contract', 'export_package', 'List_Tenders', 'list_tenders ']) {
          const res = await app.inject({
            method: 'POST',
            url: '/chatgpt-app/mcp',
            headers,
            payload: rpc('tools/call', { name: forbiddenName, arguments: {} }),
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.result).toBeUndefined();
          expect(body.error.code).toBe(-32001);
        }
        // Ningún efecto: la organización sigue sin propuestas ni aprobaciones.
        const proposals = await db.query('select count(*)::int as n from proposals where org_id = $1', [org.id]);
        expect(proposals.rows[0].n).toBe(0);
      });

      it('get_tender / get_approval_status / get_compliance_matrix sobre una convocatoria de OTRA organización no filtran datos (error de negocio, nunca el dato ajeno)', async () => {
        const a = await setup('mcp-adv-a');
        const b = await setup('mcp-adv-b');
        const tenderIdB = await createTender(app, b.org.id, 'mcp-adv-b-001', 'Convocatoria secreta de B');

        for (const toolName of ['get_tender', 'get_approval_status', 'get_compliance_matrix']) {
          const res = await app.inject({
            method: 'POST',
            url: '/chatgpt-app/mcp',
            headers: a.headers,
            payload: rpc('tools/call', { name: toolName, arguments: { tenderId: tenderIdB } }),
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.result.isError).toBe(true);
          expect(body.result.content[0].text).toMatch(/no encontrada/i);
          const raw = JSON.stringify(body);
          expect(raw).not.toContain(tenderIdB);
          expect(raw).not.toContain('Convocatoria secreta de B');
        }
      });

      it('argumentos inválidos producen isError:true en vez de un 500 o datos fabricados', async () => {
        const { headers } = await setup('mcp-adv-invalid');
        const res = await app.inject({
          method: 'POST',
          url: '/chatgpt-app/mcp',
          headers,
          payload: rpc('tools/call', { name: 'get_compliance_matrix', arguments: { tenderId: 'no-es-un-uuid' } }),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.result.isError).toBe(true);
        expect(body.result.content[0].text).toMatch(/argumentos inválidos/i);
      });

      it('resources/read con una URI arbitraria o de path traversal se rechaza sin leer nada del sistema de archivos', async () => {
        const { headers } = await setup('mcp-adv-uri');
        for (const uri of ['file:///etc/passwd', 'ui://chatgpt-app/../../secret', 'ui://chatgpt-app/convocatorias-widget?x=1', '']) {
          const res = await app.inject({ method: 'POST', url: '/chatgpt-app/mcp', headers, payload: rpc('resources/read', { uri }) });
          const body = res.json();
          expect(body.result).toBeUndefined();
          expect(body.error.code).toBe(-32002);
        }
      });

      it('un método JSON-RPC desconocido devuelve METHOD_NOT_FOUND, no un 500', async () => {
        const { headers } = await setup('mcp-adv-method');
        const res = await app.inject({ method: 'POST', url: '/chatgpt-app/mcp', headers, payload: rpc('tools/delete_everything') });
        expect(res.statusCode).toBe(200);
        expect(res.json().error.code).toBe(-32601);
      });

      it('un cuerpo JSON-RPC malformado devuelve INVALID_REQUEST, no un 500', async () => {
        const { headers } = await setup('mcp-adv-malformed');
        const res = await app.inject({ method: 'POST', url: '/chatgpt-app/mcp', headers, payload: { foo: 'bar' } });
        expect(res.statusCode).toBe(200);
        expect(res.json().error.code).toBe(-32600);
      });
    });
  });
});
