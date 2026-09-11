import { FakeProvider, OpenAIResponsesProvider, type LLMProvider } from '@atiende/agents';

/**
 * Elige el proveedor real solo si hay credenciales; si no, `FakeProvider`
 * determinista (documentado en `packages/agents/README.md`: pasar con
 * `FakeProvider` NO certifica ninguna integración real). Mismo patrón
 * (mismo nombre de función, mismo criterio) que
 * `apps/worker/src/handlers/run-agent.ts::buildLlmProvider` -- `apps/api`
 * no tenía hasta ahora ningún consumidor de `@atiende/agents` que
 * necesitara un `LLMProvider` propio; el primero es
 * `modules/onboarding/routes.ts` (patrón Likida/atiende.ai #7).
 */
export function buildLlmProvider(openaiApiKey?: string): LLMProvider {
  if (openaiApiKey) return new OpenAIResponsesProvider({ apiKey: openaiApiKey });
  return new FakeProvider();
}
