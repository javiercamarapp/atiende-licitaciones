import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient, DbExecutor } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';
import { matchProcedures, isPgvectorAvailable } from '../src/modules/matching/semantic.js';

async function seedTenderDirect(
  db: DbClient,
  orgId: string,
  externalId: string,
  opts: { title?: string; budgetAmount?: number; cpvCodes?: string[] } = {}
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into tenders (id, org_id, source, external_id, title, budget_amount, cpv_codes)
     values ($1, $2, 'test', $3, $4, $5, $6)`,
    [id, orgId, externalId, opts.title ?? 'Convocatoria de prueba', opts.budgetAmount ?? null, opts.cpvCodes ?? []]
  );
  return id;
}

/** Corre `fn` en una transacción con el MISMO contexto de tenant que usan las rutas reales (`set local role app_role` + `app.current_org_id`), para poder probar la RLS real en vez de la conexión de superusuario que usan los fixtures. */
async function asOrgRole<T>(db: DbClient, orgId: string, userId: string, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
    return fn(tx);
  });
}

describe('REQ-006: motor de matching semántico (embeddings + pgvector, con fallback determinista)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('la migración 0099 dejó tender_embeddings/company_profile_embeddings con RLS activa; sin OPENAI_API_KEY en el entorno de test se usa el proveedor fake (nunca red)', async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const { rows } = await db.query<{ available: boolean }>('select app.pgvector_available() as available');
    // Documenta el entorno real de esta suite (PGlite): confirma por qué el
    // resto de este archivo ejercita el camino de FALLBACK determinista, no
    // el de pgvector real.
    expect(rows[0].available).toBe(false);
  });

  it('el criterio "semantic_similarity" aparece cuando el perfil y la convocatoria tienen texto real, y NO aparece cuando el perfil está vacío (sin inventar señal)', async () => {
    const owner = await registerAndLogin(app, 'sem-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Sem Org 1', 'sem-org-1');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const tenderId = await seedTenderDirect(db, org.id, 'sem-ext-1', {
      title: 'Construcción de escuela primaria rural en el estado de Jalisco',
    });

    // 1) Sin capacidades/productos capturados: el criterio semántico NO
    //    aparece (mismo criterio que el resto del matching ante datos
    //    ausentes -- REQ-166, nunca se inventa una señal).
    const withoutProfile = await app.inject({ method: 'GET', url: `/matching/tenders/${tenderId}`, headers });
    expect(withoutProfile.statusCode).toBe(200);
    const criteriaWithout = withoutProfile.json().relevance.criteria as Array<{ criterion: string }>;
    expect(criteriaWithout.some((c) => c.criterion === 'semantic_similarity')).toBe(false);

    // 2) Con al menos una capacidad capturada: el criterio semántico SÍ
    //    aparece, con explicación auditable (REQ-168).
    await db.query("insert into capabilities (org_id, name) values ($1, 'Construcción de infraestructura educativa')", [org.id]);
    const withProfile = await app.inject({ method: 'GET', url: `/matching/tenders/${tenderId}`, headers });
    expect(withProfile.statusCode).toBe(200);
    const criteriaWith = withProfile.json().relevance.criteria as Array<{ criterion: string; explanation: string }>;
    const semanticCriterion = criteriaWith.find((c) => c.criterion === 'semantic_similarity');
    expect(semanticCriterion).toBeDefined();
    expect(semanticCriterion!.explanation).toContain('Similitud semántica');
  });

  it('CACHÉ REAL: reutiliza el embedding ya calculado en vez de recomputarlo -- se detecta forzando el vector cacheado a una dirección OPUESTA y confirmando que el siguiente cómputo la usa', async () => {
    const owner = await registerAndLogin(app, 'sem-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Sem Org 2', 'sem-org-2');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await db.query("insert into capabilities (org_id, name) values ($1, 'Servicios de auditoría financiera')", [org.id]);
    const tenderId = await seedTenderDirect(db, org.id, 'sem-ext-2', { title: 'Servicios de auditoría financiera anual' });

    const first = await app.inject({ method: 'GET', url: `/matching/tenders/${tenderId}`, headers });
    expect(first.statusCode).toBe(200);
    const firstCriteria = first.json().relevance.criteria as Array<{ criterion: string; score: number }>;
    const firstSemantic = firstCriteria.find((c) => c.criterion === 'semantic_similarity')!;
    expect(firstSemantic.score).toBeGreaterThan(0); // vocabulario compartido real -> similitud positiva real.

    // Fuerza el vector CACHEADO de la convocatoria a la dirección opuesta
    // del de perfil, dejando `source_text_hash`/`model` intactos (para que
    // el código de caché los considere válidos y NO recalcule desde el
    // texto -- si recalculara, obtendría el mismo vector de siempre y este
    // test no distinguiría "usa caché" de "ignora caché").
    const { rows: profileRows } = await db.query<{ embedding_fallback: number[] }>(
      'select embedding_fallback from company_profile_embeddings where org_id = $1',
      [org.id]
    );
    const profileVec = profileRows[0].embedding_fallback;
    const oppositeVec = profileVec.map((v) => -v);
    await db.query('update tender_embeddings set embedding_fallback = $1 where org_id = $2 and tender_id = $3', [
      oppositeVec,
      org.id,
      tenderId,
    ]);

    const second = await app.inject({ method: 'GET', url: `/matching/tenders/${tenderId}`, headers });
    expect(second.statusCode).toBe(200);
    const secondCriteria = second.json().relevance.criteria as Array<{ criterion: string; score: number }>;
    const secondSemantic = secondCriteria.find((c) => c.criterion === 'semantic_similarity')!;
    // Coseno con el vector opuesto -> -1 -> score0to100 = 0 -> contribución 0.
    expect(secondSemantic.score).toBe(0);
  });

  it('REQ-006 (texto real): el embedding usa el texto extraído de los ANEXOS TÉCNICOS reales, no solo el título -- una convocatoria con título genérico pero un anexo muy afín al perfil da similitud alta', async () => {
    const owner = await registerAndLogin(app, 'sem-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Sem Org 3', 'sem-org-3');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await db.query("insert into capabilities (org_id, name) values ($1, 'Desarrollo de software de nómina y recursos humanos')", [org.id]);

    // Título deliberadamente genérico/sin relación léxica ni temática obvia
    // con el perfil -- toda la señal semántica real debe venir del anexo.
    const tenderId = await seedTenderDirect(db, org.id, 'sem-ext-3', { title: 'Convocatoria pública 2026-014' });
    await db.query(
      "insert into tender_documents (org_id, tender_id, document_type, storage_ref, extracted_text) values ($1, $2, 'bases', 'ref-3', $3)",
      [org.id, tenderId, 'Se requiere el desarrollo de un sistema de software para la gestión de nómina y recursos humanos del organismo.']
    );

    const res = await app.inject({ method: 'GET', url: `/matching/tenders/${tenderId}`, headers });
    expect(res.statusCode).toBe(200);
    const criteria = res.json().relevance.criteria as Array<{ criterion: string; score: number; maxScore: number }>;
    const semanticCriterion = criteria.find((c) => c.criterion === 'semantic_similarity')!;
    expect(semanticCriterion).toBeDefined();
    // Con vocabulario real y sustancial compartido SOLO vía el anexo
    // (nómina/recursos humanos/software/desarrollo), el criterio debe
    // aportar una fracción significativa de su peso máximo -- si el código
    // ignorara `tender_documents` y solo mirara el título, esto sería 0.
    expect(semanticCriterion.score).toBeGreaterThan(semanticCriterion.maxScore * 0.3);
  });

  it('un documento subido pero sin extracted_text (aún no procesado) se omite sin inventar contenido -- nunca produce un error ni un texto sintético', async () => {
    const owner = await registerAndLogin(app, 'sem-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'Sem Org 4', 'sem-org-4');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await db.query("insert into capabilities (org_id, name) values ($1, 'Servicios de limpieza')", [org.id]);
    const tenderId = await seedTenderDirect(db, org.id, 'sem-ext-4', { title: 'Servicios de limpieza de oficinas' });
    await db.query(
      "insert into tender_documents (org_id, tender_id, document_type, storage_ref, extracted_text) values ($1, $2, 'bases', 'ref-4', null)",
      [org.id, tenderId]
    );

    const res = await app.inject({ method: 'GET', url: `/matching/tenders/${tenderId}`, headers });
    expect(res.statusCode).toBe(200);
    const criteria = res.json().relevance.criteria as Array<{ criterion: string }>;
    // El título por sí solo ya es texto utilizable -> el criterio semántico
    // SIGUE apareciendo (basado en título), solo que sin el anexo vacío.
    expect(criteria.some((c) => c.criterion === 'semantic_similarity')).toBe(true);
  });

  it('AISLAMIENTO REAL (REQ-059/061, RLS): una organización NO puede leer los embeddings de otra ni con una query que omita el filtro por org_id', async () => {
    // App/DB propias (como el test A5 de matching-and-go-no-go.test.ts):
    // este caso por sí solo hace 2 registros/logins y el rate limit de
    // `/auth/login` es 5/min por IP sobre la MISMA app -- usar la app
    // compartida del `beforeAll` (que ya acumuló logins de otros `it` de
    // este archivo) produciría un 429 que no tiene nada que ver con lo que
    // se está probando aquí.
    const { app: freshApp, db: freshDb } = await createTestApp();
    try {
      const ownerA = await registerAndLogin(freshApp, 'sem-owner-a@example.com');
      const orgA = await createOrgFor(freshApp, ownerA, 'Sem Org A', 'sem-org-a');
      const ownerB = await registerAndLogin(freshApp, 'sem-owner-b@example.com');
      const orgB = await createOrgFor(freshApp, ownerB, 'Sem Org B', 'sem-org-b');

      await freshDb.query("insert into capabilities (org_id, name) values ($1, 'Construcción de carreteras')", [orgA.id]);
      const tenderA = await seedTenderDirect(freshDb, orgA.id, 'sem-ext-a', { title: 'Construcción de carreteras rurales' });

      // Genera el embedding real de orgA/tenderA visitando la ruta como orgA.
      const asA = await freshApp.inject({
        method: 'GET',
        url: `/matching/tenders/${tenderA}`,
        headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id },
      });
      expect(asA.statusCode).toBe(200);

      // Como orgB (rol real app_role + org_id de orgB), una query SIN filtro
      // por org_id (el peor caso: un bug que "olvide" el WHERE) NO debe ver
      // la fila de orgA -- la barrera real es la RLS de la tabla, no el
      // filtro de la aplicación.
      const leaked = await asOrgRole(freshDb, orgB.id, ownerB.id, (tx) =>
        tx.query('select 1 from tender_embeddings where tender_id = $1', [tenderA])
      );
      expect(leaked.rows).toEqual([]);

      const leakedProfile = await asOrgRole(freshDb, orgB.id, ownerB.id, (tx) =>
        tx.query('select 1 from company_profile_embeddings where org_id = $1', [orgA.id])
      );
      expect(leakedProfile.rows).toEqual([]);
    } finally {
      await freshApp.close();
      await freshDb.close();
    }
  });

  it('RPC match_procedures (fallback determinista): devuelve las convocatorias de la organización ordenadas por similitud, sin fugar las de otra organización', async () => {
    // App/DB propias, mismo motivo que el caso de aislamiento de arriba.
    const { app: freshApp, db: freshDb } = await createTestApp();
    try {
      const ownerA = await registerAndLogin(freshApp, 'sem-owner-mp-a@example.com');
      const orgA = await createOrgFor(freshApp, ownerA, 'Sem MP Org A', 'sem-mp-org-a');
      const ownerB = await registerAndLogin(freshApp, 'sem-owner-mp-b@example.com');
      const orgB = await createOrgFor(freshApp, ownerB, 'Sem MP Org B', 'sem-mp-org-b');

      const tenderClose = await seedTenderDirect(freshDb, orgA.id, 'mp-ext-close');
      const tenderFar = await seedTenderDirect(freshDb, orgA.id, 'mp-ext-far');
      const tenderOtherOrg = await seedTenderDirect(freshDb, orgB.id, 'mp-ext-other-org');

      const dims = 8;
      const closeVec = [1, 0, 0, 0, 0, 0, 0, 0];
      const farVec = [0, 1, 0, 0, 0, 0, 0, 0];
      const otherOrgVec = [1, 0, 0, 0, 0, 0, 0, 0]; // idéntico al "cercano", pero de OTRA organización -- no debe aparecer.
      const queryVec = [1, 0, 0, 0, 0, 0, 0, 0];

      for (const [orgId, tenderId, vec] of [
        [orgA.id, tenderClose, closeVec],
        [orgA.id, tenderFar, farVec],
        [orgB.id, tenderOtherOrg, otherOrgVec],
      ] as const) {
        await freshDb.query(
          `insert into tender_embeddings (org_id, tender_id, source_text_hash, model, dims, embedding_fallback)
           values ($1, $2, 'test-hash', 'test-model', $3, $4)`,
          [orgId, tenderId, dims, vec]
        );
      }

      const pgvectorOn = await asOrgRole(freshDb, orgA.id, ownerA.id, (tx) => isPgvectorAvailable(tx));
      expect(pgvectorOn).toBe(false); // documenta el camino que se está probando (ver primer test del archivo).

      const results = await asOrgRole(freshDb, orgA.id, ownerA.id, (tx) => matchProcedures(tx, orgA.id, queryVec, 10));

      expect(results.map((r) => r.tenderId)).toEqual([tenderClose, tenderFar]);
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
      expect(results.some((r) => r.tenderId === tenderOtherOrg)).toBe(false);

      // `limit` se respeta.
      const limited = await asOrgRole(freshDb, orgA.id, ownerA.id, (tx) => matchProcedures(tx, orgA.id, queryVec, 1));
      expect(limited).toHaveLength(1);
      expect(limited[0].tenderId).toBe(tenderClose);
    } finally {
      await freshApp.close();
      await freshDb.close();
    }
  });
});
