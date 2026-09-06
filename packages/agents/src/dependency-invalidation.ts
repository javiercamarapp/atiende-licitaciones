import { isoNow } from "./types.js";

/**
 * DependencyInvalidation (docs/AMPLIACION-BACKOFFICE.md §3/§7): un cambio en
 * las bases de una convocatoria o en su plazo debe invalidar/marcar para
 * revisión automáticamente cualquier corrida o aprobación que dependía de
 * la versión anterior. Nada se marca "aprobado"/"listo" sobre una versión
 * de origen que ya cambió por debajo.
 *
 * `dependsOnKey` identifica la entidad de origen (p. ej.
 * `convocatoria:<id>:bases`, `convocatoria:<id>:plazo`) y `dependsOnVersion`
 * es la versión/hash de esa entidad capturada cuando se registró la
 * dependencia. `invalidate()` se llama cuando llega un evento real de
 * cambio (nueva versión de bases, acta de aclaraciones, plazo adelantado).
 */

export interface DependencyLink {
  runId: string;
  dependsOnKey: string;
  dependsOnVersion: string;
}

export interface InvalidationEvent {
  runId: string;
  dependsOnKey: string;
  previousVersion: string;
  newVersion: string;
  timestamp: string;
  reason: string;
}

export class DependencyInvalidationRegistry {
  private readonly linksByKey = new Map<string, DependencyLink[]>();
  private readonly invalidations = new Map<string, InvalidationEvent>();

  /** Registra que `runId` (o una aprobación/artefacto identificado por ese id) depende de una versión concreta de `dependsOnKey`. */
  registerDependency(runId: string, dependsOnKey: string, dependsOnVersion: string): void {
    const links = this.linksByKey.get(dependsOnKey) ?? [];
    links.push({ runId, dependsOnKey, dependsOnVersion });
    this.linksByKey.set(dependsOnKey, links);
  }

  /**
   * Marca como invalidado todo lo que dependía de una versión de `dependsOnKey`
   * distinta de `newVersion`. Retorna los `runId` recién invalidados. Ya
   * invalidados previamente no se vuelven a reportar (idempotente).
   */
  invalidate(dependsOnKey: string, newVersion: string, reason: string): string[] {
    const links = this.linksByKey.get(dependsOnKey) ?? [];
    const timestamp = isoNow();
    const newlyInvalidated: string[] = [];

    for (const link of links) {
      if (link.dependsOnVersion === newVersion) continue; // ya está alineado con la versión nueva
      if (this.invalidations.has(link.runId)) continue; // ya invalidado antes
      this.invalidations.set(link.runId, {
        runId: link.runId,
        dependsOnKey,
        previousVersion: link.dependsOnVersion,
        newVersion,
        timestamp,
        reason,
      });
      newlyInvalidated.push(link.runId);
    }
    return newlyInvalidated;
  }

  isInvalidated(runId: string): boolean {
    return this.invalidations.has(runId);
  }

  getInvalidation(runId: string): InvalidationEvent | undefined {
    return this.invalidations.get(runId);
  }

  /** Limpia el estado de invalidación de un run (p. ej. tras regenerar sobre la nueva versión). */
  clearInvalidation(runId: string): void {
    this.invalidations.delete(runId);
  }
}
