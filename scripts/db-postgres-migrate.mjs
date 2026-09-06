#!/usr/bin/env node
/**
 * Aplica TODAS las migraciones de packages/db, una a una, contra un Postgres
 * REAL (no PGlite), usando el runner de `@atiende/db` (packages/db/src/migrate.ts
 * + driver.ts) tal como lo consumiría producción. Pensado para el job
 * `db-postgres` de `.github/workflows/quality.yml` (servicio Postgres 16),
 * siguiendo el patrón descrito en docs/investigacion/likida-arquitectura.md
 * §4 (migraciones aplicadas una por una sobre Postgres real en CI, nunca en
 * batch silencioso).
 *
 * IMPORTANTE (léase antes de tocar este archivo): `packages/db/src/driver.ts`
 * SÍ soporta Postgres real vía `createPgClient({ connectionString })` cuando
 * `DATABASE_URL` empieza por `postgres://`/`postgresql://` — verificado
 * leyendo el código, no asumido. Por eso este script llama a `applyMigrations`
 * de verdad contra ese cliente, en vez de fingir éxito o degradar a PGlite.
 *
 * Este script NO modifica packages/db (fuera del alcance de quien lo escribió):
 * solo consume su API pública exportada (`@atiende/db`).
 */

import { createPgClient, applyMigrations, listMigrationFiles } from '@atiende/db';

function redact(url) {
  return url.replace(/:\/\/([^:@/]+):([^@]*)@/, '://$1:***@');
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const isRealPostgres = /^postgres(ql)?:\/\//.test(databaseUrl);

  if (!isRealPostgres) {
    // No fingimos éxito: este script existe específicamente para probar
    // Postgres real. Si no hay una URL real, es un error de configuración
    // del job de CI, no un "skip" silencioso.
    console.error(
      `[db-postgres-migrate] DATABASE_URL debe ser una URL de Postgres real ` +
        `(postgres://... o postgresql://...). Valor recibido: ${databaseUrl ? redact(databaseUrl) : '(vacío)'}`
    );
    console.error(
      '[db-postgres-migrate] runner sin soporte pg NO es el caso aquí (driver.ts sí soporta pg); ' +
        'esto es una URL mal configurada en el job de CI.'
    );
    process.exit(1);
  }

  const files = listMigrationFiles();
  console.log(
    `[db-postgres-migrate] ${files.length} migraciones encontradas en packages/db/migrations. ` +
      `Aplicando una a una contra ${redact(databaseUrl)} ...`
  );

  const db = await createPgClient({ connectionString: databaseUrl });
  try {
    const result = await applyMigrations(db);
    for (const f of result.applied) console.log(`  APLICADA  ${f}`);
    for (const f of result.skipped) console.log(`  YA ESTABA ${f}`);

    const total = result.applied.length + result.skipped.length;
    if (total !== files.length) {
      console.error(
        `[db-postgres-migrate] Discrepancia: ${total} migraciones registradas, ${files.length} archivos en disco.`
      );
      process.exit(1);
    }

    console.log(
      `[db-postgres-migrate] OK: ${result.applied.length} aplicadas, ${result.skipped.length} ya presentes, ` +
        `${files.length} en total. Postgres real, dialect=${db.dialect}.`
    );
  } catch (err) {
    // applyMigrations aplica en orden y lanza en cuanto una falla (no sigue
    // con las siguientes ni hace commit de un estado a medias en otras
    // migraciones): consultamos schema_migrations para reportar EXACTAMENTE
    // hasta dónde llegó, en vez de solo repetir el stack trace.
    try {
      const { rows } = await db.query('select filename from schema_migrations order by filename');
      const appliedSet = new Set(rows.map((r) => r.filename));
      const firstPending = files.find((f) => !appliedSet.has(f));
      console.error(
        `[db-postgres-migrate] FALLÓ. ${rows.length}/${files.length} migraciones quedaron aplicadas antes del error. ` +
          `Primera migración pendiente/fallida: ${firstPending ?? '(desconocida)'}.`
      );
    } catch (introspectionErr) {
      console.error(
        '[db-postgres-migrate] FALLÓ y además no se pudo leer schema_migrations para diagnosticar hasta dónde llegó:',
        introspectionErr
      );
    }
    console.error(err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[db-postgres-migrate] error inesperado:', err);
  process.exit(1);
});
