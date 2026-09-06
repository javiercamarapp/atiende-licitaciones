import { describe, it, expect } from 'vitest';
import { BoundedCache } from '../src/lib/bounded-cache.js';

/**
 * AE-10 (docs/auditoria-2/api-expediente.md, BAJA hoy / MEDIA latente;
 * extiende DB-09): `runContextCache` en `lib/agent-stores.pg.ts` era un
 * `Map` sin límite de tamaño -- crecería sin cota mientras el proceso
 * viva. `BoundedCache` (lib/bounded-cache.ts) es el LRU acotado que ahora
 * usan `PgRunStore`/`PgToolCallStore`.
 */
describe('AE-10: BoundedCache -- LRU con tamaño máximo acotado', () => {
  it('nunca crece más allá de maxEntries: descarta la entrada usada menos recientemente', () => {
    const cache = new BoundedCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(3);

    cache.set('d', 4); // 'a' es la más antigua sin uso -> se descarta.
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('un `get` reciente protege la entrada de ser la próxima en descartarse', () => {
    const cache = new BoundedCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' pasa a ser la más recientemente usada; 'b' queda como la más antigua.
    cache.set('c', 3); // debe descartar 'b', no 'a'.
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('insertar miles de claves nunca deja que el tamaño supere el límite (protección real de memoria)', () => {
    const cache = new BoundedCache<number, number>(100);
    for (let i = 0; i < 10_000; i += 1) {
      cache.set(i, i);
    }
    expect(cache.size).toBe(100);
    // Las últimas 100 claves insertadas sobreviven; las anteriores no.
    expect(cache.get(9_999)).toBe(9_999);
    expect(cache.get(0)).toBeUndefined();
  });
});
