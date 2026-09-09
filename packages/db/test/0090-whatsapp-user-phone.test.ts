import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMigratedDb, seedUser } from './helpers.js';
import type { DbClient } from '../src/driver.js';

/**
 * 0090_req_whatsapp_user_phone: columna aditiva `users.whatsapp_phone_e164`
 * (nullable, formato E.164) para el canal ADICIONAL de WhatsApp
 * (@atiende/whatsapp) de los avisos `tender_matches`/`submission`. Ver el
 * comentario de la propia migración para el porqué de "por usuario, no por
 * organización".
 */
describe('0090: users.whatsapp_phone_e164', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('existe como columna nullable de users', async () => {
    const { rows } = await db.query<{ column_name: string; is_nullable: string; data_type: string }>(
      "select column_name, is_nullable, data_type from information_schema.columns where table_name = 'users' and column_name = 'whatsapp_phone_e164'"
    );
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].data_type).toBe('text');
  });

  it('una fila preexistente sin backfill queda con el número en null (aditiva, no destructiva)', async () => {
    const userId = await seedUser(db, 'whatsapp-sin-numero@example.com');
    const { rows } = await db.query<{ whatsapp_phone_e164: string | null }>(
      'select whatsapp_phone_e164 from users where id = $1',
      [userId]
    );
    expect(rows[0].whatsapp_phone_e164).toBeNull();
  });

  it('acepta un número en formato E.164 válido', async () => {
    const userId = await seedUser(db, 'whatsapp-numero-valido@example.com');
    await db.query('update users set whatsapp_phone_e164 = $1 where id = $2', ['+525512345678', userId]);
    const { rows } = await db.query<{ whatsapp_phone_e164: string | null }>(
      'select whatsapp_phone_e164 from users where id = $1',
      [userId]
    );
    expect(rows[0].whatsapp_phone_e164).toBe('+525512345678');
  });

  it('rechaza un número sin el signo "+" inicial', async () => {
    const userId = await seedUser(db, 'whatsapp-sin-mas@example.com');
    await expect(
      db.query('update users set whatsapp_phone_e164 = $1 where id = $2', ['525512345678', userId])
    ).rejects.toThrow();
  });

  it('rechaza un número que empieza en cero tras el "+" (E.164 exige el primer dígito distinto de cero)', async () => {
    const userId = await seedUser(db, 'whatsapp-cero-inicial@example.com');
    await expect(
      db.query('update users set whatsapp_phone_e164 = $1 where id = $2', ['+0512345678', userId])
    ).rejects.toThrow();
  });

  it('rechaza texto que no es un número (letras, espacios)', async () => {
    const userId = await seedUser(db, 'whatsapp-texto-invalido@example.com');
    await expect(
      db.query('update users set whatsapp_phone_e164 = $1 where id = $2', ['+52 55 abcd', userId])
    ).rejects.toThrow();
  });
});
