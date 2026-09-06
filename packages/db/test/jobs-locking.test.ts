import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createPgliteClient } from '../src/driver.js';
import { applyMigrations } from '../src/migrate.js';
import { seedOrg } from './helpers.js';

/**
 * LIMITACIÓN CONOCIDA DE PGLITE (documentada también en README):
 * PGlite es una base de datos embebida de una sola conexión/proceso (como
 * SQLite), no un servidor con múltiples backends concurrentes reales. No es
 * posible abrir dos conexiones simultáneas independientes contra la misma
 * instancia para reproducir una carrera real a nivel de sistema operativo
 * como se haría con dos clientes `pg.Pool` contra Postgres real.
 *
 * Lo que SÍ se puede verificar aquí, y es lo que realmente garantiza la
 * ausencia de doble procesamiento, es que la sentencia de reclamo de trabajo
 * es una única sentencia UPDATE atómica con subquery `FOR UPDATE SKIP LOCKED`:
 * Postgres ejecuta esa sentencia como una unidad indivisible, así que aunque
 * N "workers" lógicos disparen la misma sentencia concurrentemente (vía
 * Promise.all) contra la única conexión de PGlite, el resultado observable
 * (cada job es reclamado como máximo una vez) es el mismo invariante que
 * protege la ejecución en Postgres real con conexiones concurrentes de
 * verdad. Este test prueba ese invariante de la consulta, no la concurrencia
 * de PGlite en sí (que no se puede reproducir en este entorno).
 *
 * Para reproducir concurrencia real de sistema operativo, hay que correr
 * este mismo patrón de claim contra un Postgres real (`pg.Pool` con varias
 * conexiones); no se ejecuta aquí porque el entorno de pruebas no tiene
 * Postgres/Docker disponible (ver docs/logs/api-ronda1.log).
 */

const CLAIM_SQL = `
  update jobs
  set status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1
  where id = (
    select id from jobs
    where org_id = $1 and status = 'queued' and next_run_at <= now()
    order by next_run_at
    for update skip locked
    limit 1
  )
  returning id
`;

describe('jobs: reclamo seguro con FOR UPDATE SKIP LOCKED', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createPgliteClient();
    await applyMigrations(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('cada job es reclamado como máximo por un worker, sin duplicados, con N workers > M jobs', async () => {
    const org = await seedOrg(db, 'org-jobs');
    const jobCount = 5;
    const jobIds: string[] = [];
    for (let i = 0; i < jobCount; i++) {
      const { rows } = await db.query<{ id: string }>(
        "insert into jobs (org_id, kind) values ($1, 'test') returning id",
        [org.orgId]
      );
      jobIds.push((rows[0] as any).id);
    }

    const workerCount = 10;
    const claims = await Promise.all(
      Array.from({ length: workerCount }, (_, i) => db.query<{ id: string }>(CLAIM_SQL, [org.orgId, `worker-${i}`]))
    );

    const claimedIds = claims.flatMap((r) => r.rows.map((row: any) => row.id));
    // Ningún id repetido entre los reclamos.
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    // Se reclamaron exactamente todos los jobs disponibles, ni más ni menos.
    expect(claimedIds.sort()).toEqual([...jobIds].sort());

    const { rows: remaining } = await db.query(
      "select count(*)::int as n from jobs where org_id = $1 and status = 'queued'",
      [org.orgId]
    );
    expect((remaining[0] as any).n).toBe(0);

    const { rows: running } = await db.query(
      "select count(*)::int as n from jobs where org_id = $1 and status = 'running'",
      [org.orgId]
    );
    expect((running[0] as any).n).toBe(jobCount);
  });

  it('un job sin candidatos (todos corriendo) no es reclamado dos veces por workers adicionales', async () => {
    const org = await seedOrg(db, 'org-jobs-2');
    await db.query("insert into jobs (org_id, kind) values ($1, 'only-one')", [org.orgId]);

    const [first, second] = await Promise.all([
      db.query<{ id: string }>(CLAIM_SQL, [org.orgId, 'w1']),
      db.query<{ id: string }>(CLAIM_SQL, [org.orgId, 'w2']),
    ]);

    const totalClaimed = first.rows.length + second.rows.length;
    expect(totalClaimed).toBe(1);
  });
});
