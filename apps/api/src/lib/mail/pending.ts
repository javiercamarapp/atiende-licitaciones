import type { FastifyInstance } from 'fastify';

/**
 * REQ-181..195: algunos correos se disparan SIN `await` desde el manejador
 * HTTP (registro, invitación, contacto) porque esperarlos reabriría un
 * oráculo de temporización (API-03: un registro nuevo manda correo, uno
 * duplicado no -- si se esperara, la diferencia de latencia volvería a
 * distinguirlos) o convertiría un fallo transitorio del proveedor en un 500
 * de una operación que sí tuvo éxito.
 *
 * Un `void promise` suelto tiene dos problemas reales, ninguno de pruebas:
 * un rechazo sin `catch` tumba el proceso de Node (`unhandledRejection`), y
 * cerrar la app (`app.close()`, un despliegue rodante) puede dejar la
 * escritura del outbox a medias contra un pool ya cerrado. Este registro
 * resuelve ambos: captura el error (lo deja en el log, nunca en la
 * respuesta) y expone `app.waitForPendingMail()`, que el cierre ordenado -- y
 * las pruebas de integración, que necesitan determinismo, no un `sleep`
 * arbitrario -- pueden esperar.
 */
export class PendingMailTracker {
  private readonly pending = new Set<Promise<unknown>>();

  track(promise: Promise<unknown>): void {
    const wrapped = promise.finally(() => {
      this.pending.delete(wrapped);
    });
    this.pending.add(wrapped);
  }

  /** Espera a que TODO envío disparado sin `await` haya terminado (o fallado). */
  async wait(): Promise<void> {
    // Un envío puede encolar otro (p.ej. el job `mail_retry`): se vacía en
    // bucle hasta que no quede nada nuevo, nunca una sola pasada.
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  get size(): number {
    return this.pending.size;
  }
}

/**
 * Dispara un envío en segundo plano dejando rastro en el log si falla --
 * NUNCA propaga el error al manejador HTTP que lo disparó.
 */
export function fireAndForgetMail(app: FastifyInstance, what: string, run: () => Promise<unknown>): void {
  app.pendingMail.track(
    run().catch((error: unknown) => {
      app.log.error({ err: error instanceof Error ? error.message : String(error), correo: what }, 'Fallo al enviar correo en segundo plano');
    })
  );
}
