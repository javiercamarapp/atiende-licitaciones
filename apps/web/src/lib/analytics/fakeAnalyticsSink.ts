import type { AnalyticsEvent, AnalyticsSink } from "./piiGuard";

/**
 * Adaptador FAKE del puerto `AnalyticsSink`, solo para pruebas. Nunca sale a
 * la red -- guarda los eventos recibidos en memoria para que la prueba
 * pueda inspeccionarlos. Mismo patrón que `FakeProvider`
 * (`packages/agents/src/llm/fake-provider.ts`): se mockea el BORDE externo
 * (a dónde llegan los eventos), nunca la lógica de negocio real de
 * `piiGuard.ts` (`assertNoPii`/`guardAnalyticsSink`), que corre sin mocks en
 * las pruebas.
 *
 * IMPORTANTE: que un evento llegue aquí en una prueba NO certifica ninguna
 * integración con un proveedor de analítica real -- ninguno existe todavía
 * en este repo (`verificado_contra_real=false`, ver `piiGuard.ts`).
 */
export class FakeAnalyticsSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];

  send(event: AnalyticsEvent): void {
    this.events.push(event);
  }
}
