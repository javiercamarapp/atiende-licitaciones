import { apiRequest } from "./client";
import { myOrgSchema, invitationSchema, type MyOrg, type OrgRole, type Invitation } from "./schemas";
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
