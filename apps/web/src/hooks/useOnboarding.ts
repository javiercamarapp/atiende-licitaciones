// Patrón Likida/atiende.ai #7 (onboarding conversacional con guardas
// deterministas). A diferencia de los hooks de useCompany.ts, esta query
// NUNCA se deshabilita por falta de `currentOrgId` -- responde también
// antes de que exista organización (primer turno: "¿cómo se llama tu
// organización?"), así que se dispara siempre que haya sesión.
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { getOnboardingState } from "@/lib/api/onboarding";

export function useOnboardingState() {
  const { currentOrgId, status } = useAuth();
  return useQuery({
    queryKey: ["onboarding", "state", currentOrgId],
    queryFn: () => getOnboardingState(currentOrgId),
    enabled: status === "authenticated",
    // El texto se recalcula solo/no molesta si queda desactualizado un
    // instante -- no vale la pena reintentar agresivamente ni refrescar en
    // segundo plano; el usuario dispara un refetch de facto al completar
    // cada paso del wizard (invalidación cruzada, ver OnboardingPage.tsx).
    retry: false,
  });
}
