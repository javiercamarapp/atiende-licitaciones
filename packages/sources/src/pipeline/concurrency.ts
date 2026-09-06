/** Ejecuta `worker` sobre cada elemento de `items` con un máximo de `limit` ejecuciones concurrentes. */
export async function runWithConcurrencyLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => runOne());
  await Promise.all(workers);
  return results;
}
