import { QueryClient } from "@tanstack/react-query";

// Instancia única compartida por App.tsx (QueryClientProvider) y
// useAuth.tsx (logout/switchOrg). Vive en su propio módulo (en vez de
// crearse dentro de App.tsx) precisamente para que useAuth.tsx pueda
// importarla directamente sin depender de `useQueryClient()` (ese hook
// exige un <QueryClientProvider> como ancestro, que no todos los árboles de
// prueba de useAuth.tsx montan — ver useAuth.test.tsx).
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/**
 * WI-03 (docs/auditoria-2/web-integrado.md): las queries de negocio
 * (empresa, convocatorias, matching, Go/No-Go, agentes) incluyen
 * `currentOrgId` en su `queryKey` — cambiar de organización no las deja
 * filtrar datos entre organizaciones. Pero las queries admin/globales
 * (`["admin", ...]`, `["tenders", "sources-freshness"]`) NO están
 * asociadas a ninguna organización ni usuario, así que sin esto un cambio
 * de organización (o un segundo usuario que inicia sesión tras el logout
 * del primero en un navegador compartido) puede pintar por un instante
 * datos en caché de la sesión/organización anterior antes de que el
 * refetch en segundo plano los reemplace.
 */
export function clearUnscopedQueries(client: QueryClient = queryClient): void {
  client.removeQueries({ queryKey: ["admin"] });
  client.removeQueries({ queryKey: ["tenders", "sources-freshness"] });
}
