/**
 * Helper compartido de pruebas (EX-EXP-17): desde que `ApprovalWorkflow.
 * approve()`/`revalidateAgainstCurrentHash()`/`isFullyApprovedForCurrentHash()`
 * y `PackageAssembler.buildManifest()` exigen un `HashedInputs` sellado por
 * `sealInputs()`/`computeInputsHash()` (nunca un `string` plano), los tests
 * que antes usaban valores como `"hash-1"`/`"h"` directamente necesitan un
 * `ExpedienteInputs` real de donde derivar ese hash. `fakeExpedienteInputs`
 * produce un `ExpedienteInputs` determinista y distinto por `seed` (dos
 * seeds distintos SIEMPRE producen hashes distintos, vía `tenderVersionHash`);
 * `fakeHashedInputs` lo sella directamente con `sealInputs`.
 */
import { sealInputs, type ExpedienteInputs, type HashedInputs } from "../../src/proposal-version.js";

export function fakeExpedienteInputs(seed: string, overrides: Partial<ExpedienteInputs> = {}): ExpedienteInputs {
  return {
    tenderVersionHash: `bases-${seed}`,
    companyProfileHash: `perfil-${seed}`,
    companyDocuments: [{ documentId: "doc-32d", hash: `doc32d-${seed}`, vigenteHasta: null }],
    rates: [{ concept: "consultoria_hora", hash: `tarifa-${seed}` }],
    templates: [{ templateId: "carta-propuesta", hash: `plantilla-${seed}` }],
    ...overrides,
  };
}

export function fakeHashedInputs(seed: string, overrides: Partial<ExpedienteInputs> = {}): HashedInputs {
  return sealInputs(fakeExpedienteInputs(seed, overrides));
}
