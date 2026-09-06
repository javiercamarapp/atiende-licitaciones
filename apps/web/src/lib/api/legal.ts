// Aviso de privacidad versionado (REQ-119/REQ-131), servido por apps/api
// desde `apps/api/docs/legal/privacy-notice.md` -- ruta PÚBLICA (sin
// autenticación): un aviso de privacidad debe poder consultarse antes de
// crear una cuenta. `rawRequest` (no `apiRequest`) porque esta ruta nunca
// exige `Authorization`/`X-Org-Id`.
import { rawRequest } from "./http";
import { privacyNoticeSchema, type PrivacyNotice } from "./schemas";

export async function getPrivacyNotice(): Promise<PrivacyNotice> {
  const raw = await rawRequest<unknown>("/legal/privacy-notice");
  return privacyNoticeSchema.parse(raw);
}
