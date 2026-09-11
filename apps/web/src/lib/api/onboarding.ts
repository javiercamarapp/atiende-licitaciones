// Patrón Likida/atiende.ai #7 (onboarding conversacional con guardas
// deterministas) -- cliente tipado de GET /onboarding/state (apps/api/src/
// modules/onboarding/routes.ts). `orgId` es OPCIONAL a propósito (a
// diferencia de company.ts): este endpoint responde también antes de que
// exista ninguna organización, que es justo el primer turno de la
// conversación ("¿cómo se llama tu organización?").
import { apiRequest } from "./client";
import { onboardingStateSchema, type OnboardingState } from "./schemas";

export async function getOnboardingState(orgId?: string | null): Promise<OnboardingState> {
  const raw = await apiRequest<unknown>("/onboarding/state", { orgId });
  return onboardingStateSchema.parse(raw);
}
