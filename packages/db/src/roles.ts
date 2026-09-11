export const ORG_ROLES = ['owner', 'admin', 'analyst', 'writer', 'reviewer', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const WRITE_ROLES: OrgRole[] = ['owner', 'admin', 'analyst', 'writer', 'reviewer'];
export const DECISION_ROLES: OrgRole[] = ['owner', 'admin', 'analyst'];
export const MEMBERSHIP_ADMIN_ROLES: OrgRole[] = ['owner', 'admin'];

/** REQ-060: tipo de organización -- lado proveedor (todo lo existente) vs.
 *  lado comprador (OIC/contraloría). Ver packages/db/migrations/0099. */
export const ORG_KINDS = ['proveedor', 'comprador'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

/** REQ-060: catálogo de roles del lado comprador, DELIBERADAMENTE separado
 *  de `ORG_ROLES` (aislamiento propio de roles respecto al lado proveedor,
 *  no una extensión del mismo enum) -- ver packages/db/migrations/0099. */
export const OIC_ROLES = ['director_oic', 'analista_oic', 'consulta_oic'] as const;
export type OicRole = (typeof OIC_ROLES)[number];

/** consulta_oic nunca escribe (paralelo de 'viewer' en el lado proveedor). */
export const OIC_WRITE_ROLES: OicRole[] = ['director_oic', 'analista_oic'];
/** Único rol con autoridad para dar de alta/baja miembros OIC (paralelo de owner/admin). */
export const OIC_MEMBERSHIP_ADMIN_ROLES: OicRole[] = ['director_oic'];
