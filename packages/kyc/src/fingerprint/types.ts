/** Tipos del fingerprint de entidad para detectar interpósita persona ENTRE tenants (REQ-111, LGRA Art. 67 / LAASSP Art. 90-V). */

export interface EntityFingerprintInput {
  orgId: string;
  orgName: string;
  /** `company_profiles.tax_id`. */
  rfc: string | null;
  /** Domicilio primario de `locations` (is_primary = true), o el único si hay exactamente uno. `null` si no hay ninguno declarado o hay varios sin uno marcado primario (no se adivina cuál usar). */
  domicilio: { addressLine?: string | null; city?: string | null; state?: string | null; postalCode?: string | null } | null;
  /** `authorized_signatories`: firmantes/representantes legales declarados. */
  representantes: Array<{ fullName: string; idDocumentRef?: string | null }>;
  /** `company_stakeholders`: socios/accionistas declarados. */
  socios: Array<{ fullName: string; rfc?: string | null }>;
}

export type FingerprintFieldKind = "rfc" | "domicilio" | "representante" | "socio";

export interface FingerprintMatchedField {
  field: FingerprintFieldKind;
  /** Valor normalizado compartido (nunca el documento de identidad crudo -- para representantes se usa el nombre normalizado o el `idDocumentRef` normalizado como RFC, nunca ambos expuestos). */
  value: string;
}

export interface EntityFingerprint {
  orgId: string;
  orgName: string;
  rfc: string | null;
  domicilioKey: string | null;
  /** Claves normalizadas y deduplicadas de representantes (por `idDocumentRef` si luce como RFC, si no por nombre). */
  representanteKeys: string[];
  /** Claves normalizadas y deduplicadas de socios (por `rfc` si está declarado, si no por nombre). */
  socioKeys: string[];
}

export interface FingerprintMatchResult {
  orgIdA: string;
  orgIdB: string;
  orgNameA: string;
  orgNameB: string;
  score: number;
  matchedFields: FingerprintMatchedField[];
}
