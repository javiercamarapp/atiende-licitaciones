/**
 * Etiquetas legibles de `OrgRole` (ver lib/api/schemas.ts) — compartidas
 * entre OrganizationSwitcher (header) y SidebarAccountBlock (tarjeta de
 * usuario del sidebar), un solo lugar de verdad.
 */
export const ROLE_LABELS: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  analyst: "Analista",
  writer: "Editor",
  reviewer: "Revisor",
  viewer: "Solo lectura",
};
