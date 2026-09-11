import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import {
  createMigratedDb,
  seedOrg,
  seedMember,
  seedUser,
  seedOicOrg,
  seedOicMember,
  seedSuperadmin,
  asActor,
  DOMAIN_TABLES,
} from './helpers.js';

/**
 * REQ-060: "Separación estricta de datos por tenant para producto de lado
 * comprador (OIC/contralorías): nunca exponer información privada de
 * proveedores propios" -- criterio verificable (docs/ACEPTACION.md):
 * "Test de aislamiento confirma que el producto de lado comprador no
 * expone datos de proveedores propios".
 *
 * Ver packages/db/migrations/0103_req060_oic_module.sql para el diseño
 * completo (nota al inicio del archivo).
 */
describe('REQ-060: módulo comprador (OIC) -- aislamiento de datos y roles', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe('exclusión mutua de catálogos de roles (por construcción, no solo por política)', () => {
    it('organizations.kind es "proveedor" por defecto -- ninguna organización existente cambia de comportamiento', async () => {
      const org = await seedOrg(db, 'org-default-kind');
      const { rows } = await db.query<{ kind: string }>('select kind from organizations where id = $1', [org.orgId]);
      expect(rows[0].kind).toBe('proveedor');
    });

    it('rechaza insertar en memberships (rol de proveedor) para una organización kind=comprador', async () => {
      const oicOrg = await seedOicOrg(db, 'org-comprador-reject-membership');
      const { rows } = await db.query<{ id: string }>(
        "insert into users (email, password_hash) values ('reject-membership@example.com', 'x') returning id"
      );
      await expect(
        db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [oicOrg.orgId, rows[0].id])
      ).rejects.toThrow(/memberships \(rol de proveedor\) solo admite/i);
    });

    it('rechaza insertar en oic_memberships (rol OIC) para una organización kind=proveedor', async () => {
      const org = await seedOrg(db, 'org-proveedor-reject-oic-membership');
      const userId = await seedMember(db, org.orgId, 'alguien@example.com', 'owner');
      await expect(
        db.query("insert into oic_memberships (org_id, user_id, role) values ($1, $2, 'director_oic')", [org.orgId, userId])
      ).rejects.toThrow(/oic_memberships \(rol de comprador\/OIC\) solo admite/i);
    });

    it('rechaza convertir en "comprador" una organización que ya tiene membresías de proveedor', async () => {
      const org = await seedOrg(db, 'org-no-flip-to-comprador');
      await seedMember(db, org.orgId, 'owner-noflip@example.com', 'owner');
      await expect(db.query("update organizations set kind = 'comprador' where id = $1", [org.orgId])).rejects.toThrow(
        /ya tiene membresías de proveedor/i
      );
    });

    it('rechaza convertir en "proveedor" una organización que ya tiene membresías OIC', async () => {
      const oicOrg = await seedOicOrg(db, 'org-no-flip-to-proveedor');
      await seedOicMember(db, oicOrg.orgId, 'director-noflip@example.com', 'director_oic');
      await expect(db.query("update organizations set kind = 'proveedor' where id = $1", [oicOrg.orgId])).rejects.toThrow(
        /ya tiene membresías OIC/i
      );
    });

    it('permite crear filas de oic_watch_items solo bajo una organización kind=comprador (defensa en profundidad)', async () => {
      const org = await seedOrg(db, 'org-proveedor-reject-watch-item');
      await expect(
        db.query(
          "insert into oic_watch_items (org_id, source, external_id, title) values ($1, 'comprasmx', 'EXT-1', 'x')",
          [org.orgId]
        )
      ).rejects.toThrow(/oic_watch_items solo admite organizaciones kind=comprador/i);
    });
  });

  describe('bootstrap y RLS de oic_memberships (paralelo del bootstrap de memberships)', () => {
    it('el primer director_oic se autoinserta sin membresía previa; un segundo alta exige director_oic', async () => {
      const oicOrg = await seedOicOrg(db, 'org-oic-bootstrap');
      const directorId = await seedOicMember(db, oicOrg.orgId, 'director-bootstrap@example.com', 'director_oic');

      // Un analista_oic NO puede dar de alta a un tercero (solo director_oic administra membresías).
      // Los usuarios se crean directamente (como propietario, sin RLS) --
      // insertarlos vía `asActor` con RETURNING fallaría por una razón
      // AJENA a lo que esta prueba verifica: `sel_users` solo deja ver la
      // fila propia, y Postgres exige satisfacer esa política de SELECT
      // para poder devolver el RETURNING de un INSERT.
      const analystId = await seedUser(db, 'analista-bootstrap@example.com');
      await db.query("insert into oic_memberships (org_id, user_id, role) values ($1, $2, 'analista_oic')", [
        oicOrg.orgId,
        analystId,
      ]);

      const thirdUser = await seedUser(db, 'tercero-bootstrap@example.com');
      await expect(
        asActor(db, { orgId: oicOrg.orgId, userId: analystId }, (tx) =>
          tx.query("insert into oic_memberships (org_id, user_id, role) values ($1, $2, 'consulta_oic')", [
            oicOrg.orgId,
            thirdUser,
          ])
        )
      ).rejects.toThrow(/row-level security/i);

      // El director_oic sí puede.
      const added = await asActor(db, { orgId: oicOrg.orgId, userId: directorId }, (tx) =>
        tx.query(
          "insert into oic_memberships (org_id, user_id, role) values ($1, $2, 'consulta_oic') returning id",
          [oicOrg.orgId, thirdUser]
        )
      );
      expect(added.rows.length).toBe(1);
    });

    it('consulta_oic puede leer oic_watch_items pero no puede escribir (INSERT/UPDATE)', async () => {
      const oicOrg = await seedOicOrg(db, 'org-oic-consulta-readonly');
      await seedOicMember(db, oicOrg.orgId, 'director-ro@example.com', 'director_oic');
      const consultaId = await seedOicMember(db, oicOrg.orgId, 'consulta-ro@example.com', 'consulta_oic');
      const { rows } = await db.query<{ id: string }>(
        "insert into oic_watch_items (org_id, source, external_id, title) values ($1, 'comprasmx', 'EXT-RO', 'Procedimiento RO') returning id",
        [oicOrg.orgId]
      );
      const watchItemId = rows[0].id;

      const seen = await asActor(db, { orgId: oicOrg.orgId, userId: consultaId }, (tx) =>
        tx.query('select id from oic_watch_items where id = $1', [watchItemId])
      );
      expect(seen.rows.length).toBe(1);

      await expect(
        asActor(db, { orgId: oicOrg.orgId, userId: consultaId }, (tx) =>
          tx.query(
            "insert into oic_watch_items (org_id, source, external_id, title) values ($1, 'comprasmx', 'EXT-RO-2', 'x')",
            [oicOrg.orgId]
          )
        )
      ).rejects.toThrow(/row-level security/i);

      const upd = await asActor(db, { orgId: oicOrg.orgId, userId: consultaId }, (tx) =>
        tx.query("update oic_watch_items set status = 'cerrado' where id = $1", [watchItemId])
      );
      expect(upd.rowCount).toBe(0);
    });

    it('aislamiento entre dos organizaciones compradoras (OIC B nunca ve datos de OIC C)', async () => {
      const oicB = await seedOicOrg(db, 'org-oic-b');
      const oicC = await seedOicOrg(db, 'org-oic-c');
      const directorB = await seedOicMember(db, oicB.orgId, 'director-b@example.com', 'director_oic');
      await seedOicMember(db, oicC.orgId, 'director-c@example.com', 'director_oic');
      const { rows } = await db.query<{ id: string }>(
        "insert into oic_watch_items (org_id, source, external_id, title) values ($1, 'comprasmx', 'EXT-C', 'Procedimiento de C') returning id",
        [oicC.orgId]
      );
      const itemFromC = rows[0].id;

      const seenByB = await asActor(db, { orgId: oicB.orgId, userId: directorB }, (tx) =>
        tx.query('select id from oic_watch_items where id = $1', [itemFromC])
      );
      expect(seenByB.rows.length).toBe(0);

      const membershipsOfC = await asActor(db, { orgId: oicB.orgId, userId: directorB }, (tx) =>
        tx.query('select id from oic_memberships where org_id = $1', [oicC.orgId])
      );
      expect(membershipsOfC.rows.length).toBe(0);
    });
  });

  describe('aislamiento comprador -> proveedor: núcleo del criterio de aceptación de REQ-060', () => {
    it('un actor puramente OIC (sin ninguna membresía de proveedor en ningún lado) no ve, edita ni borra NINGUNA fila de dominio del proveedor, en ninguna de las tablas privadas existentes', async () => {
      const oicOrg = await seedOicOrg(db, 'org-oic-puro');
      const oicUserId = await seedOicMember(db, oicOrg.orgId, 'director-puro@example.com', 'director_oic');

      for (const spec of DOMAIN_TABLES) {
        // Una organización proveedora NUEVA por tabla (mismo patrón que
        // rls-isolation.test.ts): varias specs comparten `seedAux`
        // (p.ej. `insertTenderAux`, que siembra un tender con external_id
        // derivado solo del org_id) -- reutilizar una única organización
        // para las ~30 tablas violaría la unicidad `(org_id, source,
        // external_id)` de `tenders` en la segunda spec que la use.
        const supplierOrg = await seedOrg(db, `org-proveedor-vs-oic-puro-${spec.table}`);
        await seedMember(db, supplierOrg.orgId, `owner-puro-${spec.table}@example.com`, 'owner');
        const aux = spec.seedAux ? await spec.seedAux(db, supplierOrg.orgId) : {};
        const rowId = await spec.insertRow(db, supplierOrg.orgId, aux);

        // Caso 1: el actor OIC opera en su propio contexto (org_id = su
        // organización compradora) -- la fila del proveedor es de OTRA
        // organización, así que ya la filtra `org_id = current_org_id()`.
        const seenOwnCtx = await asActor(db, { orgId: oicOrg.orgId, userId: oicUserId }, (tx) =>
          tx.query(`select id from ${spec.table} where id = $1`, [rowId])
        );
        expect(seenOwnCtx.rows.length, `${spec.table}: contexto propio OIC no debe ver la fila del proveedor`).toBe(0);

        // Caso 2 (el ataque real que importa para REQ-060): el actor OIC
        // FUERZA `X-Org-Id` a la organización proveedora (simulación de un
        // encabezado manipulado / bug de enrutamiento). Como el usuario OIC
        // JAMÁS tiene una fila en `memberships` (garantizado por el trigger
        // de exclusión mutua), `app.has_role(...)` es falso sin importar
        // qué org_id fije -- 0 filas, nunca una excepción de "no autorizado"
        // que confirmara la existencia del dato.
        const seenForcedCtx = await asActor(db, { orgId: supplierOrg.orgId, userId: oicUserId }, (tx) =>
          tx.query(`select id from ${spec.table} where id = $1`, [rowId])
        );
        expect(
          seenForcedCtx.rows.length,
          `${spec.table}: actor OIC con X-Org-Id forzado al proveedor no debe ver la fila`
        ).toBe(0);

        const forcedUpdate = await asActor(db, { orgId: supplierOrg.orgId, userId: oicUserId }, (tx) =>
          tx.query(`update ${spec.table} set created_at = created_at where id = $1`, [rowId])
        );
        expect(forcedUpdate.rowCount, `${spec.table}: UPDATE forzado no debe afectar ninguna fila`).toBe(0);

        const forcedDelete = await asActor(db, { orgId: supplierOrg.orgId, userId: oicUserId }, (tx) =>
          tx.query(`delete from ${spec.table} where id = $1`, [rowId])
        );
        expect(forcedDelete.rowCount, `${spec.table}: DELETE forzado no debe borrar ninguna fila`).toBe(0);
      }
    });

    it('un usuario "de doble vida" (owner de una organización proveedora Y director_oic de una compradora) no filtra datos del proveedor mientras opera en contexto OIC', async () => {
      const supplierOrg = await seedOrg(db, 'org-proveedor-doble-vida');
      const oicOrg = await seedOicOrg(db, 'org-oic-doble-vida');

      // MISMO usuario físico en ambos lados -- creado una sola vez.
      const { rows } = await db.query<{ id: string }>(
        "insert into users (email, password_hash) values ('doble-vida@example.com', 'x') returning id"
      );
      const dualUserId = rows[0].id;
      await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
        supplierOrg.orgId,
        dualUserId,
      ]);
      await db.query("insert into oic_memberships (org_id, user_id, role) values ($1, $2, 'director_oic')", [
        oicOrg.orgId,
        dualUserId,
      ]);

      const supplierTenderId = (
        await db.query<{ id: string }>(
          "insert into tenders (org_id, source, external_id, title) values ($1, 'test', 'ext-doble-vida', 'Convocatoria privada') returning id",
          [supplierOrg.orgId]
        )
      ).rows[0].id;
      const supplierProposalId = (
        await db.query<{ id: string }>(
          "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta privada') returning id",
          [supplierOrg.orgId, supplierTenderId]
        )
      ).rows[0].id;

      // Con el contexto de sesión puesto en la organización COMPRADORA
      // (como ocurriría al usar el producto OIC), el mismo usuario no debe
      // poder leer NADA de su propia organización proveedora.
      const tendersSeen = await asActor(db, { orgId: oicOrg.orgId, userId: dualUserId }, (tx) =>
        tx.query('select id from tenders where id = $1', [supplierTenderId])
      );
      expect(tendersSeen.rows.length).toBe(0);

      const proposalsSeen = await asActor(db, { orgId: oicOrg.orgId, userId: dualUserId }, (tx) =>
        tx.query('select id from proposals where id = $1', [supplierProposalId])
      );
      expect(proposalsSeen.rows.length).toBe(0);

      // Verificación de control: en su contexto REAL de proveedor, el mismo
      // usuario sí ve sus propios datos (confirma que no es un problema de
      // sembrado, sino aislamiento correcto solo cuando cambia el contexto).
      const controlSeen = await asActor(db, { orgId: supplierOrg.orgId, userId: dualUserId }, (tx) =>
        tx.query('select id from tenders where id = $1', [supplierTenderId])
      );
      expect(controlSeen.rows.length).toBe(1);

      // Y en su contexto de proveedor, tampoco ve los watch items de SU
      // propia organización OIC (misma garantía en la dirección inversa).
      const watchItemId = (
        await db.query<{ id: string }>(
          "insert into oic_watch_items (org_id, source, external_id, title) values ($1, 'comprasmx', 'EXT-DV', 'x') returning id",
          [oicOrg.orgId]
        )
      ).rows[0].id;
      const watchItemsFromSupplierCtx = await asActor(db, { orgId: supplierOrg.orgId, userId: dualUserId }, (tx) =>
        tx.query('select id from oic_watch_items where id = $1', [watchItemId])
      );
      expect(watchItemsFromSupplierCtx.rows.length).toBe(0);
    });

    it('organizations: un actor OIC ve/edita su propia organización compradora pero nunca una proveedora', async () => {
      const supplierOrg = await seedOrg(db, 'org-proveedor-orgs-visibility');
      await seedMember(db, supplierOrg.orgId, 'owner-orgvis@example.com', 'owner');
      const oicOrg = await seedOicOrg(db, 'org-oic-orgs-visibility');
      const directorId = await seedOicMember(db, oicOrg.orgId, 'director-orgvis@example.com', 'director_oic');

      const seen = await asActor(db, { orgId: oicOrg.orgId, userId: directorId }, (tx) =>
        tx.query('select id from organizations where id in ($1, $2)', [oicOrg.orgId, supplierOrg.orgId])
      );
      const seenIds = seen.rows.map((r: any) => r.id);
      expect(seenIds).toContain(oicOrg.orgId);
      expect(seenIds).not.toContain(supplierOrg.orgId);

      const renamedOwn = await asActor(db, { orgId: oicOrg.orgId, userId: directorId }, (tx) =>
        tx.query("update organizations set name = 'OIC renombrado' where id = $1", [oicOrg.orgId])
      );
      expect(renamedOwn.rowCount).toBe(1);

      const renameOther = await asActor(db, { orgId: oicOrg.orgId, userId: directorId }, (tx) =>
        tx.query("update organizations set name = 'hackeado' where id = $1", [supplierOrg.orgId])
      );
      expect(renameOther.rowCount).toBe(0);
    });

    it('sin contexto de sesión no se ve ninguna fila de oic_memberships ni oic_watch_items', async () => {
      const oicOrg = await seedOicOrg(db, 'org-oic-sin-contexto');
      await seedOicMember(db, oicOrg.orgId, 'nadie-oic@example.com', 'director_oic');
      await db.query(
        "insert into oic_watch_items (org_id, source, external_id, title) values ($1, 'comprasmx', 'EXT-NOCTX', 'x')",
        [oicOrg.orgId]
      );

      const memberships = await asActor(db, {}, (tx) => tx.query('select id from oic_memberships'));
      expect(memberships.rows.length).toBe(0);
      const watchItems = await asActor(db, {}, (tx) => tx.query('select id from oic_watch_items'));
      expect(watchItems.rows.length).toBe(0);
    });

    it('superadmin sigue viendo ambos lados sin importar el contexto de org (comportamiento de plataforma ya existente, no roto por REQ-060)', async () => {
      const supplierOrg = await seedOrg(db, 'org-proveedor-super-oic');
      await seedMember(db, supplierOrg.orgId, 'owner-super-oic@example.com', 'owner');
      const oicOrg = await seedOicOrg(db, 'org-oic-super');
      await seedOicMember(db, oicOrg.orgId, 'director-super@example.com', 'director_oic');
      const superId = await seedSuperadmin(db, 'super-oic@example.com');

      const orgs = await asActor(db, { userId: superId }, (tx) => tx.query('select id, kind from organizations'));
      const orgIds = orgs.rows.map((r: any) => r.id);
      expect(orgIds).toEqual(expect.arrayContaining([supplierOrg.orgId, oicOrg.orgId]));
    });
  });
});
