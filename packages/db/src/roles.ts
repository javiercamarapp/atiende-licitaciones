export const ORG_ROLES = ['owner', 'admin', 'analyst', 'writer', 'reviewer', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const WRITE_ROLES: OrgRole[] = ['owner', 'admin', 'analyst', 'writer', 'reviewer'];
export const DECISION_ROLES: OrgRole[] = ['owner', 'admin', 'analyst'];
export const MEMBERSHIP_ADMIN_ROLES: OrgRole[] = ['owner', 'admin'];
