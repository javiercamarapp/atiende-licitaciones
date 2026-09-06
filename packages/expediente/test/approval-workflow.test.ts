import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalWorkflow, resetApprovalCounters } from "../src/approval-workflow.js";
import { sealInputs } from "../src/proposal-version.js";
import { sha256Hex } from "../src/types.js";
import { fakeExpedienteInputs, fakeHashedInputs } from "./helpers/hashed-inputs.js";

describe("ApprovalWorkflow — estados y roles (REQ-159/REQ-161)", () => {
  beforeEach(() => resetApprovalCounters());

  it("transiciona borrador -> en_revision -> aprobado con roles válidos", () => {
    const wf = new ApprovalWorkflow();
    expect(wf.getState()).toBe("borrador");

    const submit = wf.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    expect(submit.ok).toBe(true);
    expect(wf.getState()).toBe("en_revision");

    const approve = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("hash-1") });
    expect(approve.ok).toBe(true);
    expect(wf.getState()).toBe("aprobado");
    expect(wf.isFullyApproved()).toBe(true);
  });
});

describe("ApprovalWorkflow — A12 rol indebido (REQ-062/REQ-165)", () => {
  beforeEach(() => resetApprovalCounters());

  it("rechaza aprobación desde rol 'writer'", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-a", actorRole: "writer" });
    const result = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-b", actorRole: "writer", inputsHash: fakeHashedInputs("h") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("rol_no_autorizado_para_aprobar");
    expect(wf.getState()).not.toBe("aprobado");
  });

  it("rechaza aprobación desde rol 'viewer'", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-a", actorRole: "owner" });
    const result = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-c", actorRole: "viewer", inputsHash: fakeHashedInputs("h") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("rol_no_autorizado_para_aprobar");
  });

  it("rechaza autoaprobación: quien envió a revisión no puede aprobar su propio expediente, aunque tenga rol reviewer", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "documento:tecnica", actorId: "user-a", actorRole: "writer" });
    const result = wf.approve({ scope: "documento", scopeRef: "documento:tecnica", actorId: "user-a", actorRole: "reviewer", inputsHash: fakeHashedInputs("h") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("autoaprobacion_prohibida");
  });

  it("rechaza envío a revisión desde rol 'viewer'", () => {
    const wf = new ApprovalWorkflow();
    const result = wf.requestReview({ scopeRef: "expediente", actorId: "user-a", actorRole: "viewer" });
    expect(result.ok).toBe(false);
  });
});

/**
 * EX-EXP-02 (residual) / EX-EXP-14 (reverificación ronda 1, severidad
 * MEDIA): ni `approve()` ni `PackageAssembler.buildManifest` validaban que
 * `scope === "expediente" ⟹ scopeRef === "expediente"`. Una aprobación mal
 * construida con `scope: "expediente"` pero `scopeRef` arbitrario
 * ("expediente-OTRO-EXPEDIENTE") contaba igual como aprobación TOTAL válida
 * del expediente correcto.
 */
describe("ApprovalWorkflow — EX-EXP-02/EX-EXP-14: scope 'expediente' exige scopeRef EXACTAMENTE 'expediente'", () => {
  beforeEach(() => resetApprovalCounters());

  it("rechaza approve() con scope 'expediente' y un scopeRef arbitrario distinto de la cadena 'expediente'", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    const result = wf.approve({
      scope: "expediente",
      scopeRef: "expediente-OTRO-EXPEDIENTE", // scopeRef arbitrario/inconsistente — el ataque reproducido por EX-EXP-14
      actorId: "user-reviewer",
      actorRole: "reviewer",
      inputsHash: fakeHashedInputs("hash-1"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("scope_scopeRef_inconsistente");
    expect(wf.isFullyApproved()).toBe(false);
    expect(wf.listApprovals()).toHaveLength(0);
  });

  it("scope/scopeRef distintos de 'expediente' (documento/sección) NO se ven afectados por esta validación", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "documento:tecnica", actorId: "user-a", actorRole: "writer" });
    const result = wf.approve({ scope: "documento", scopeRef: "documento:tecnica", actorId: "user-b", actorRole: "reviewer", inputsHash: fakeHashedInputs("h") });
    expect(result.ok).toBe(true);
  });
});

describe("ApprovalWorkflow — A11 edición invalida aprobación (REQ-155/REQ-162)", () => {
  beforeEach(() => resetApprovalCounters());

  it("invalida la aprobación del expediente cuando se detecta un cambio en un insumo ya aprobado", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    const approval = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("hash-v1") });
    expect(approval.ok).toBe(true);
    expect(wf.getState()).toBe("aprobado");

    const change = wf.recordChange({ scope: "documento", scopeRef: "documento:economica", reason: "tarifa_editada_tras_aprobacion" });
    expect(change.invalidatedApprovalIds).toHaveLength(1);
    expect(wf.getState()).toBe("en_revision");
    expect(wf.isFullyApproved()).toBe(false);

    const approvals = wf.listApprovals();
    expect(approvals[0].status).toBe("invalidada");
    expect(approvals[0].invalidatedReason).toBe("tarifa_editada_tras_aprobacion");
  });

  it("una nueva aprobación tras el cambio vuelve a dejar 'aprobado' el expediente", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("hash-v1") });
    wf.recordChange({ scope: "seccion", scopeRef: "seccion:tecnica:experiencia", reason: "dato_editado" });
    expect(wf.isFullyApproved()).toBe(false);

    wf.requestReview({ scopeRef: "expediente", actorId: "user-writer-2", actorRole: "writer" });
    const reapproval = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-admin", actorRole: "admin", inputsHash: fakeHashedInputs("hash-v2") });
    expect(reapproval.ok).toBe(true);
    expect(wf.isFullyApproved()).toBe(true);
  });

  it("un cambio en una sección invalida también la aprobación de alcance expediente que la cubre (jerarquía de alcance)", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("h") });
    const change = wf.recordChange({ scope: "seccion", scopeRef: "seccion:tecnica:experiencia", reason: "cambio_bases" });
    expect(change.invalidatedApprovalIds).toHaveLength(1);
    expect(wf.activeApprovalsCovering("expediente")).toHaveLength(0);
  });

  it("un cambio en una sección NO invalida una aprobación de una sección distinta e independiente", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "seccion", scopeRef: "seccion:tecnica:experiencia", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("h") });
    wf.approve({ scope: "seccion", scopeRef: "seccion:tecnica:capacidad", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("h2") });

    wf.recordChange({ scope: "seccion", scopeRef: "seccion:tecnica:experiencia", reason: "cambio" });

    expect(wf.activeApprovalsCovering("seccion:tecnica:experiencia")).toHaveLength(0);
    expect(wf.activeApprovalsCovering("seccion:tecnica:capacidad")).toHaveLength(1);
  });
});

describe("ApprovalWorkflow — EX-EXP-01: invalidación AUTOMÁTICA por hash de insumos divergente (REQ-162)", () => {
  beforeEach(() => resetApprovalCounters());

  it("revalidateAgainstCurrentHash invalida automáticamente una aprobación 'vigente' cuando el hash actual difiere, sin que nadie llame recordChange a mano", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("hash-aprobado") });
    expect(wf.isFullyApproved()).toBe(true);

    const change = wf.revalidateAgainstCurrentHash({ scopeRef: "expediente", currentInputsHash: fakeHashedInputs("hash-nuevo-tras-cambio-de-tarifa") });

    expect(change).not.toBeNull();
    expect(change!.invalidatedApprovalIds).toHaveLength(1);
    expect(wf.isFullyApproved()).toBe(false);
    expect(wf.listApprovals()[0].status).toBe("invalidada");
    expect(wf.listApprovals()[0].invalidatedReason).toContain("hash_insumos_divergente");
    expect(wf.listChanges()).toHaveLength(1);
  });

  it("revalidateAgainstCurrentHash no hace nada si el hash actual coincide con el aprobado", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("hash-x") });

    const change = wf.revalidateAgainstCurrentHash({ scopeRef: "expediente", currentInputsHash: fakeHashedInputs("hash-x") });

    expect(change).toBeNull();
    expect(wf.isFullyApproved()).toBe(true);
    expect(wf.listChanges()).toHaveLength(0);
  });

  it("isFullyApprovedForCurrentHash recalcula y refleja la invalidación automática en una sola llamada", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("hash-v1") });

    expect(wf.isFullyApprovedForCurrentHash(fakeHashedInputs("hash-v1"))).toBe(true);
    // La tarifa cambió: el hash recalculado ya no es el mismo.
    expect(wf.isFullyApprovedForCurrentHash(fakeHashedInputs("hash-v2-tarifa-cambiada"))).toBe(false);
    expect(wf.listApprovals()[0].status).toBe("invalidada");
  });
});

/**
 * EX-EXP-17 (reverificación ronda 2, ALTA — mismo hilo que EX-EXP-01/11):
 * `approve()`/`revalidateAgainstCurrentHash()`/`isFullyApprovedForCurrentHash()`
 * aceptaban `inputsHash`/`currentInputsHash` como un `string` plano, así que
 * un hash calculado A MANO (sin relación real con ningún `ExpedienteInputs`)
 * se aceptaba igual que uno legítimo. Ahora exigen un `HashedInputs`
 * sellado por `sealInputs()`/`computeInputsHash()`, verificado con un
 * símbolo privado no falsificable desde fuera del módulo, y rechazan
 * cualquier otra cosa con `InvalidInputsHashError`.
 */
describe("ApprovalWorkflow — EX-EXP-17: inputsHash exige un HashedInputs sellado, nunca un string suelto", () => {
  beforeEach(() => resetApprovalCounters());

  it("approve() rechaza un hash de insumos calculado a mano (string plano), aunque 'parezca' un sha256 real", () => {
    const wf = new ApprovalWorkflow();
    expect(() =>
      wf.approve({
        scope: "expediente",
        scopeRef: "expediente",
        actorId: "user-reviewer",
        actorRole: "reviewer",
        // @ts-expect-error EX-EXP-17: un string ya no es asignable a HashedInputs — ataque deliberado
        inputsHash: sha256Hex("cualquier-cosa-que-el-llamador-decida"),
      }),
    ).toThrow(/InvalidInputsHashError|STRING PLANO/);
    expect(wf.listApprovals()).toHaveLength(0);
  });

  it("approve() rechaza un objeto {inputs, hash} reensamblado a mano, incluso reusando un InputsHash LEGÍTIMO (el símbolo privado no es falsificable, ni siquiera con un hash real)", () => {
    // Deliberadamente SIN @ts-expect-error: `{ inputs, hash }` con un
    // `InputsHash` legítimo (de `fakeHashedInputs`) satisface
    // estructuralmente el tipo público `HashedInputs` — TypeScript por sí
    // solo NO puede rechazar esta reconstrucción; solo la verificación en
    // RUNTIME del símbolo privado (EX-EXP-17) lo hace.
    const legit = fakeHashedInputs("reensamblado");
    const forged: import("../src/proposal-version.js").HashedInputs = { inputs: legit.inputs, hash: legit.hash };
    const wf = new ApprovalWorkflow();
    expect(() =>
      wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: forged }),
    ).toThrow(/InvalidInputsHashError|sello interno/);
  });

  it("approve() rechaza un HashedInputs legítimo cuyos insumos fueron MUTADOS después de sellarse (hash correcto en su momento, pero ya no coincide)", () => {
    const inputs = fakeExpedienteInputs("mutable");
    const sealed = sealInputs(inputs);

    // El mismo objeto `inputs` referenciado por `sealed.inputs` se muta
    // DESPUÉS de sellarse — simula un llamador que sigue teniendo la
    // referencia y la modifica (o un bug) antes de usar el HashedInputs.
    inputs.tenderVersionHash = "bases-MUTADA-tras-sellar";

    const wf = new ApprovalWorkflow();
    expect(() =>
      wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: sealed }),
    ).toThrow(/InvalidInputsHashError|MUTADOS/);
    expect(wf.listApprovals()).toHaveLength(0);
  });

  it("revalidateAgainstCurrentHash() también rechaza un string plano como currentInputsHash", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: fakeHashedInputs("hash-1") });
    expect(() =>
      wf.revalidateAgainstCurrentHash({
        scopeRef: "expediente",
        // @ts-expect-error EX-EXP-17: un string ya no es asignable a HashedInputs — ataque deliberado
        currentInputsHash: "hash-1",
      }),
    ).toThrow(/InvalidInputsHashError|STRING PLANO/);
  });

  it("un HashedInputs legítimo (sealInputs de los mismos insumos que se aprobaron) SÍ es aceptado — no es un rechazo indiscriminado", () => {
    const wf = new ApprovalWorkflow();
    const hashed = fakeHashedInputs("ok");
    const result = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: hashed });
    expect(result.ok).toBe(true);
    expect(wf.isFullyApprovedForCurrentHash(fakeHashedInputs("ok"))).toBe(true);
  });

  /**
   * REVERIFY3-EXP-A (corrector, BAJA — derivado de EX-EXP-17): antes,
   * `isSealedHashedInputs` leía `value[SEALED_MARKER]` con acceso de
   * propiedad NORMAL, que recorre la cadena de prototipos.
   * `Object.create(unHashedInputsAjenoLegítimo)` con `inputs`/`hash` PROPIOS
   * auto-coherentes (calculados con la función pública `computeInputsHash`,
   * nunca desincronizados) HEREDABA el símbolo del prototipo y pasaba la
   * verificación sin haber pasado nunca por `sealInputs()`. Corregido con
   * `Object.hasOwn` (exige propiedad PROPIA, no heredada) + un `WeakSet`
   * por identidad de instancia — ninguna de las dos barreras puede
   * burlarse heredando de un objeto sellado ajeno.
   */
  it("approve() rechaza un objeto Object.create(hashedInputsAjeno) con inputs/hash PROPIOS auto-coherentes (el símbolo heredado ya no basta)", () => {
    const legitFromAnotherCaller = fakeHashedInputs("ajeno-legitimo");
    const ownInputs = fakeExpedienteInputs("propios-del-forjador");
    const forged = Object.create(legitFromAnotherCaller, {
      inputs: { value: ownInputs, enumerable: true },
      hash: { value: sealInputs(ownInputs).hash, enumerable: true },
    }) as import("../src/proposal-version.js").HashedInputs;

    // El símbolo privado SÍ es visible vía acceso normal (heredado) — lo que
    // ya no basta es que sea heredado en vez de propio.
    const wf = new ApprovalWorkflow();
    expect(() =>
      wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: forged }),
    ).toThrow(/InvalidInputsHashError|sello interno/);
    expect(wf.listApprovals()).toHaveLength(0);
  });
});

describe("ApprovalWorkflow — comentarios y trazabilidad", () => {
  beforeEach(() => resetApprovalCounters());

  it("registra comentarios de cualquier rol con autor y momento", () => {
    const wf = new ApprovalWorkflow();
    const comment = wf.addComment({ scopeRef: "documento:tecnica", authorId: "user-legal", authorRole: "reviewer", text: "Falta evidencia de experiencia." });
    expect(comment.text).toContain("Falta evidencia");
    expect(wf.listComments("documento:tecnica")).toHaveLength(1);
  });
});
