import { apiRequest } from "./client";
import {
  myOrgSchema,
  invitationSchema,
  membershipListResponseSchema,
  type MyOrg,
  type OrgRole,
  type Invitation,
  type MembershipListResponse,
} from "./schemas";
import { z } from "zod";

export async function listMyOrganizations(): Promise<MyOrg[]> {
  const raw = await apiRequest<unknown>("/organizations");
  return z.array(myOrgSchema).parse(raw);
}

export async function createOrganization(input: { name: string; slug: string }): Promise<MyOrg> {
  const raw = await apiRequest<unknown>("/organizations", { method: "POST", body: input });
  // POST /organizations no incluye `role` en la respuesta (el actor acaba de
  // crearla): se asume 'owner' — es la única política de bootstrap posible
  // (ver apps/api/src/modules/organizations/routes.ts).
  return myOrgSchema.parse({ ...(raw as object), role: "owner" satisfies OrgRole });
}

export async function inviteMember(orgId: string, input: { email: string; role: OrgRole }): Promise<Invitation> {
  const raw = await apiRequest<unknown>("/organizations/invitations", { method: "POST", body: input, orgId });
  return invitationSchema.parse(raw);
}

export async function acceptInvitation(token: string): Promise<{ orgId: string; role: OrgRole }> {
  return apiRequest("/organizations/invitations/accept", { method: "POST", body: { token } });
}

// --- memberships (ronda 4: GET /organizations/:orgId/memberships) --------------
// Antes (ronda 3) esta pantalla ("Usuarios y roles") quedaba honestamente
// vacía: `GET /organizations` solo devolvía las organizaciones del usuario
// ACTUAL, no la lista de miembros de una organización dada. Ver
// apps/web/README.md ("Endpoints... gaps") para el registro histórico del
// hueco, ya cerrado en apps/api ronda 4.
export async function listMemberships(orgId: string): Promise<MembershipListResponse> {
  const raw = await apiRequest<unknown>(`/organizations/${orgId}/memberships`, { orgId });
  return membershipListResponseSchema.parse(raw);
}

export async function changeMembershipRole(orgId: string, userId: string, role: OrgRole): Promise<{ userId: string; role: string }> {
  return apiRequest(`/organizations/memberships/${userId}`, { method: "PATCH", body: { role }, orgId });
}

export async function removeMembership(orgId: string, userId: string): Promise<void> {
  await apiRequest<void>(`/organizations/memberships/${userId}`, { method: "DELETE", orgId });
}
