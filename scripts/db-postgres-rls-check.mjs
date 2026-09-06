#!/usr/bin/env node
/**
 * Ataques RLS dinámicos contra Postgres REAL (no PGlite), ejecutados en el
 * job `db-postgres` de `.github/workflows/quality.yml` DESPUÉS de
 * `db-postgres-migrate.mjs`. Adapta el patrón descrito en
 * docs/investigacion/likida-arquitectura.md §4 ("pruebas adversariales de
 * RLS... `SET LOCAL request.jwt.claims` simulando PostgREST, intentan que B
 * lea/escriba datos de A") al esquema real de packages/db (GUCs
 * `app.current_org_id`/`app.current_user_id` + `SET LOCAL ROLE app_role`,
 * ver packages/db/src/context.ts), NO al mecanismo de Supabase/PostgREST que
 * usa Likida (esquema distinto).
 *
 * `packages/db/test/rls-isolation.test.ts` ya prueba esto mismo contra
 * PGlite (34 tablas). Este script deliberadamente NO repite esa suite completa
 * (viviría en packages/db, fuera de este alcance): valida el mismo invariante
 * — aislamiento por organización vía RLS + rol `app_role` — pero contra un
 * servidor Postgres real, algo que PGlite no puede probar (ver
 * packages/db/README.md "Límites conocidos de PGlite").
 *
 * Consume solo la API pública de `@atiende/db` (driver.ts, context.ts):
 * no modifica ni depende de detalles internos de packages/db.
 */

import { randomUUID } from 'node:crypto';
import { createPgClient, withTenantContext } from '@atiende/db';

function redact(url) {
  return url.replace(/:\/\/([^:@/]+):([^@]*)@/, '://$1:***@');
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    console.error(`[db-postgres-rls-check] DATABASE_URL debe ser Postgres real. Valor: ${databaseUrl || '(vacío)'}`);
    process.exit(1);
  }

  console.log(`[db-postgres-rls-check] conectando a ${redact(databaseUrl)} (rol admin/propietario de migraciones)...`);
  const db = await createPgClient({ connectionString: databaseUrl });

  const failures = [];
  const record = (label, ok, detail) => {
    console.log(`  [${ok ? 'PASA' : 'FALLA'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures.push(label);
  };

  try {
    // --- Preparación: dos organizaciones, un usuario owner en cada una, un
    // tender en la organización A. Como propietario de las migraciones
    // (bypassa RLS, igual que test/helpers.ts de packages/db) porque sembrar
    // datos de prueba no es lo que se está atacando aquí.
    const suffix = randomUUID().slice(0, 8);
    const { rows: orgARows } = await db.query(
      "insert into organizations (name, slug) values ($1, $2) returning id",
      [`RLS Check Org A ${suffix}`, `rls-check-a-${suffix}`]
    );
    const orgA = orgARows[0].id;
    const { rows: orgBRows } = await db.query(
      "insert into organizations (name, slug) values ($1, $2) returning id",
      [`RLS Check Org B ${suffix}`, `rls-check-b-${suffix}`]
    );
    const orgB = orgBRows[0].id;

    const { rows: userARows } = await db.query(
      "insert into users (email, password_hash) values ($1, 'x') returning id",
      [`rls-check-a-${suffix}@example.invalid`]
    );
    const userA = userARows[0].id;
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgA, userA]);

    const { rows: userBRows } = await db.query(
      "insert into users (email, password_hash) values ($1, 'x') returning id",
      [`rls-check-b-${suffix}@example.invalid`]
    );
    const userB = userBRows[0].id;
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [orgB, userB]);

    const { rows: tenderRows } = await db.query(
      "insert into tenders (org_id, source, external_id, title) values ($1, 'rls-check', $2, 'Tender de prueba RLS') returning id",
      [orgA, `ext-${suffix}`]
    );
    const tenderId = tenderRows[0].id;

    // --- Ataque 1: owner de la organización B intenta leer un tender de A.
    const bReadsA = await withTenantContext(db, { orgId: orgB, userId: userB }, async (tx) => {
      const { rows } = await tx.query('select id from tenders where id = $1', [tenderId]);
      return rows;
    });
    record(
      'B (viewer) no puede leer un tender de A vía RLS',
      bReadsA.length === 0,
      `filas visibles: ${bReadsA.length}`
    );

    // --- Ataque 2: mismo usuario B, pero forjando org_id = A en el filtro de
    // aplicación (simula un bug de la capa de aplicación que confía en un
    // header/org_id del cliente sin verificar membresía) — RLS debe seguir
    // aislando aunque la query pida explícitamente org_id = A.
    const bForgesOrgA = await withTenantContext(db, { orgId: orgB, userId: userB }, async (tx) => {
      const { rows } = await tx.query('select id from tenders where org_id = $1', [orgA]);
      return rows;
    });
    record(
      'B no puede leer tenders de A aunque fuerce org_id=A en el WHERE',
      bForgesOrgA.length === 0,
      `filas visibles: ${bForgesOrgA.length}`
    );

    // --- Ataque 3: sin contexto de sesión (sin SET LOCAL ROLE app_role ni
    // GUCs de org/usuario) no debe verse nada, ni siquiera dentro de la
    // propia organización.
    const noContext = await withTenantContext(db, {}, async (tx) => {
      const { rows } = await tx.query('select id from tenders where id = $1', [tenderId]);
      return rows;
    });
    record('Sin contexto de org/usuario no se ve ningún tender', noContext.length === 0, `filas visibles: ${noContext.length}`);

    // --- Control positivo: el owner de A SÍ ve su propio tender (si esto
    // fallara, los "PASA" de arriba serían falsos negativos por un problema
    // distinto, p.ej. RLS bloqueando también al dueño legítimo).
    const aReadsOwn = await withTenantContext(db, { orgId: orgA, userId: userA }, async (tx) => {
      const { rows } = await tx.query('select id from tenders where id = $1', [tenderId]);
      return rows;
    });
    record('A (owner) SÍ ve su propio tender (control positivo)', aReadsOwn.length === 1, `filas visibles: ${aReadsOwn.length}`);

    // --- Ataque 4: viewer de B no puede escribir (insertar) en su propia
    // organización — separación lectura/escritura por rol (WRITE_ROLES).
    let viewerWriteBlocked = false;
    try {
      await withTenantContext(db, { orgId: orgB, userId: userB }, async (tx) => {
        await tx.query(
          "insert into tenders (org_id, source, external_id, title) values ($1, 'rls-check', $2, 'No debería crearse')",
          [orgB, `ext-viewer-${suffix}`]
        );
      });
    } catch {
      viewerWriteBlocked = true;
    }
    record('Viewer de B no puede insertar un tender (bloqueado por RLS de escritura)', viewerWriteBlocked);
  } finally {
    await db.close();
  }

  if (failures.length > 0) {
    console.error(`[db-postgres-rls-check] FALLÓ: ${failures.length} verificación(es) de aislamiento RLS no pasaron contra Postgres real.`);
    process.exit(1);
  }
  console.log('[db-postgres-rls-check] OK: todas las verificaciones de aislamiento RLS pasaron contra Postgres real.');
}

main().catch((err) => {
  console.error('[db-postgres-rls-check] error inesperado:', err);
  process.exit(1);
});
