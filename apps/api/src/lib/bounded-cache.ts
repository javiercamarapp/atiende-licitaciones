/**
 * AE-10 (docs/auditoria-2/api-expediente.md, BAJA hoy / MEDIA latente;
 * extiende DB-09, docs/auditoria-1/db-api-reverificacion.md): la caché de
 * contexto de tenant en memoria de proceso de `lib/agent-stores.pg.ts`
 * (`PgRunStore`/`PgToolCallStore`) usaba un `Map` sin límite de tamaño ni
 * expiración -- crecería sin cota mientras el proceso viva SI algún día
 * una ruta HTTP real cablea `AgentRunner` a estos adaptadores (hoy no lo
 * hace ninguna, ver comentario en ese archivo). `BoundedCache` es un LRU
 * mínimo (sin dependencias externas): al superar `maxEntries`, descarta la
 * entrada usada MENOS recientemente; cada `get`/`set` la marca como
 * recién usada. No es una caché con expiración por tiempo (TTL) -- para
 * este caso de uso (mapear un id ya conocido a su `org_id`/`actor_id`
 * real, un valor que nunca cambia) un límite de TAMAÑO es la protección
 * relevante: el riesgo era memoria sin cota, no "datos obsoletos".
 */
export class BoundedCache<K, V> {
  private readonly store = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error(`BoundedCache requiere maxEntries entero > 0: ${maxEntries}`);
    }
  }

  get(key: K): V | undefined {
    if (!this.store.has(key)) return undefined;
    const value = this.store.get(key) as V;
    // Recencia: re-insertar mueve la clave al final del orden de iteración de `Map`.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.store.delete(key);
    this.store.set(key, value);
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value as K;
      this.store.delete(oldestKey);
    }
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  get size(): number {
    return this.store.size;
  }
}
