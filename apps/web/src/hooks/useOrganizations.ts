// Ronda 7 (onboarding, OnboardingPage.tsx): `POST /organizations` ya tenía
// cliente tipado en lib/api/organizations.ts desde antes, pero ningún hook
// ni pantalla lo usaba todavía -- crear la primera organización de una
// cuenta nueva no tenía ningún punto de entrada en la UI. Este hook además
// deja la organización recién creada como ACTIVA (mismo estado que
// esperaría cualquier paso siguiente del wizard, que depende de
// `currentOrgId` vía useAuth()).
import { useMutation } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { createOrganization } from "@/lib/api/organizations";
import type { MyOrg } from "@/lib/api/schemas";

export function useCreateOrganization() {
  const { refreshMemberships, switchOrg } = useAuth();
  return useMutation({
    mutationFn: (input: { name: string; slug: string }) => createOrganization(input),
    onSuccess: async (org: MyOrg) => {
      // `refreshMemberships()` vuelve a pedir `GET /organizations` (única
      // fuente de verdad de qué organizaciones ve el usuario) antes de
      // activar la recién creada -- sin este orden, `switchOrg` la
      // rechazaría en silencio (valida contra la lista de membresías
      // actual, ver useAuth.tsx) porque el estado en memoria de
      // AuthProvider seguiría sin conocerla todavía.
      await refreshMemberships();
      switchOrg(org.id);
    },
  });
}
