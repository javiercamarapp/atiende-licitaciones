import { describe, expect, it } from "vitest";
import {
  buildEntityFingerprint,
  compareEntityFingerprints,
  findInterpositaPersonaCandidates,
} from "../../src/fingerprint/entity-fingerprint.js";
import type { EntityFingerprintInput } from "../../src/fingerprint/types.js";

function org(overrides: Partial<EntityFingerprintInput> & { orgId: string; orgName: string }): EntityFingerprintInput {
  return {
    rfc: null,
    domicilio: null,
    representantes: [],
    socios: [],
    ...overrides,
  };
}

describe("buildEntityFingerprint + compareEntityFingerprints", () => {
  it("dos organizaciones sin ninguna señal en común: no hay match (null)", () => {
    const a = buildEntityFingerprint(org({ orgId: "org-a", orgName: "A", rfc: "AAA010101AB1" }));
    const b = buildEntityFingerprint(org({ orgId: "org-b", orgName: "B", rfc: "BBB020202CD2" }));
    expect(compareEntityFingerprints(a, b)).toBeNull();
  });

  it("mismo RFC en dos orgs distintas: score máximo con evidencia 'rfc'", () => {
    const a = buildEntityFingerprint(org({ orgId: "org-a", orgName: "A", rfc: "AAA010101AB1" }));
    const b = buildEntityFingerprint(org({ orgId: "org-b", orgName: "B", rfc: "aaa010101ab1" }));
    const match = compareEntityFingerprints(a, b);
    expect(match).not.toBeNull();
    expect(match?.score).toBe(1);
    expect(match?.matchedFields).toEqual([{ field: "rfc", value: "AAA010101AB1" }]);
  });

  it("mismo domicilio (con acentos/mayúsculas distintas) entre dos RFC distintos: match por domicilio", () => {
    const a = buildEntityFingerprint(
      org({
        orgId: "org-a",
        orgName: "A",
        rfc: "AAA010101AB1",
        domicilio: { addressLine: "Av. Insurgentes Sur 123", city: "Ciudad de México", state: "CDMX", postalCode: "03100" },
      }),
    );
    const b = buildEntityFingerprint(
      org({
        orgId: "org-b",
        orgName: "B",
        rfc: "BBB020202CD2",
        domicilio: { addressLine: "AV INSURGENTES SUR 123", city: "ciudad de mexico", state: "cdmx", postalCode: "03100" },
      }),
    );
    const match = compareEntityFingerprints(a, b);
    expect(match).not.toBeNull();
    expect(match?.matchedFields.map((m) => m.field)).toEqual(["domicilio"]);
    expect(match?.score).toBeCloseTo(0.4);
  });

  it("domicilio con menos de 2 partes declaradas nunca produce match (evita falsos positivos triviales)", () => {
    const a = buildEntityFingerprint(org({ orgId: "org-a", orgName: "A", domicilio: { city: "Puebla" } }));
    const b = buildEntityFingerprint(org({ orgId: "org-b", orgName: "B", domicilio: { city: "Puebla" } }));
    expect(compareEntityFingerprints(a, b)).toBeNull();
  });

  it("representante legal compartido (mismo RFC en idDocumentRef) entre dos tenants: match por representante", () => {
    const a = buildEntityFingerprint(
      org({ orgId: "org-a", orgName: "A", representantes: [{ fullName: "Juan Pérez López", idDocumentRef: "PELJ800101AB1" }] }),
    );
    const b = buildEntityFingerprint(
      org({ orgId: "org-b", orgName: "B", representantes: [{ fullName: "Juan Pérez López (apoderado)", idDocumentRef: "pelj800101ab1" }] }),
    );
    const match = compareEntityFingerprints(a, b);
    expect(match?.matchedFields[0].field).toBe("representante");
    expect(match?.matchedFields[0].value).toBe("rfc:PELJ800101AB1");
  });

  it("representante compartido por nombre cuando no hay documento tipo RFC: match por nombre normalizado", () => {
    const a = buildEntityFingerprint(org({ orgId: "org-a", orgName: "A", representantes: [{ fullName: "María José Núñez" }] }));
    const b = buildEntityFingerprint(org({ orgId: "org-b", orgName: "B", representantes: [{ fullName: "MARIA JOSE NUÑEZ" }] }));
    const match = compareEntityFingerprints(a, b);
    expect(match?.matchedFields[0]).toEqual({ field: "representante", value: "name:maria jose nunez" });
  });

  it("socio compartido entre dos tenants: match por socio", () => {
    const a = buildEntityFingerprint(org({ orgId: "org-a", orgName: "A", socios: [{ fullName: "Pedro Gómez", rfc: "GOMP700101XY9" }] }));
    const b = buildEntityFingerprint(org({ orgId: "org-b", orgName: "B", socios: [{ fullName: "Pedro Gómez", rfc: "GOMP700101XY9" }] }));
    const match = compareEntityFingerprints(a, b);
    expect(match?.matchedFields[0].field).toBe("socio");
  });

  it("múltiples señales compartidas acumulan score (capado en 1)", () => {
    const shared = {
      domicilio: { addressLine: "Calle Falsa 123", city: "Monterrey", state: "NL", postalCode: "64000" },
      representantes: [{ fullName: "Ana Torres", idDocumentRef: "TOAA750101AB1" }],
      socios: [{ fullName: "Luis Ramírez", rfc: "RALU650101XY1" }],
    };
    const a = buildEntityFingerprint(org({ orgId: "org-a", orgName: "A", rfc: "AAA010101AB1", ...shared }));
    const b = buildEntityFingerprint(org({ orgId: "org-b", orgName: "B", rfc: "BBB020202CD2", ...shared }));
    const match = compareEntityFingerprints(a, b);
    expect(match?.matchedFields).toHaveLength(3);
    expect(match?.score).toBe(1); // 0.4 + 0.35 + 0.35 = 1.10 -> capado a 1
  });

  it("el par (orgIdA, orgIdB) siempre se devuelve ordenado (menor primero), sin importar el orden de entrada", () => {
    const a = buildEntityFingerprint(org({ orgId: "org-z", orgName: "Z", rfc: "AAA010101AB1" }));
    const b = buildEntityFingerprint(org({ orgId: "org-a", orgName: "A", rfc: "AAA010101AB1" }));
    const match = compareEntityFingerprints(a, b);
    expect(match?.orgIdA).toBe("org-a");
    expect(match?.orgIdB).toBe("org-z");
  });

  it("nunca compara una organización consigo misma", () => {
    const a = buildEntityFingerprint(org({ orgId: "org-a", orgName: "A", rfc: "AAA010101AB1" }));
    expect(compareEntityFingerprints(a, a)).toBeNull();
  });
});

describe("findInterpositaPersonaCandidates", () => {
  it("encuentra el par sospechoso entre N organizaciones y descarta el resto (caso negativo real)", () => {
    const fingerprints = [
      buildEntityFingerprint(org({ orgId: "org-1", orgName: "Uno", rfc: "AAA010101AB1" })),
      buildEntityFingerprint(org({ orgId: "org-2", orgName: "Dos", rfc: "BBB020202CD2" })),
      buildEntityFingerprint(
        org({
          orgId: "org-3",
          orgName: "Tres (interpósita sospechosa de Uno)",
          rfc: "CCC030303EF3",
          domicilio: { addressLine: "Reforma 500", city: "CDMX", state: "CDMX", postalCode: "06600" },
        }),
      ),
      buildEntityFingerprint(
        org({
          orgId: "org-4",
          orgName: "Cuatro (comparte domicilio con Tres)",
          rfc: "DDD040404GH4",
          domicilio: { addressLine: "Reforma 500", city: "CDMX", state: "CDMX", postalCode: "06600" },
        }),
      ),
    ];

    const candidates = findInterpositaPersonaCandidates(fingerprints);
    expect(candidates).toHaveLength(1);
    expect([candidates[0].orgIdA, candidates[0].orgIdB].sort()).toEqual(["org-3", "org-4"]);
    expect(candidates[0].matchedFields[0].field).toBe("domicilio");
  });

  it("caso negativo: ninguna organización comparte nada -> sin candidatos", () => {
    const fingerprints = [
      buildEntityFingerprint(org({ orgId: "org-1", orgName: "Uno", rfc: "AAA010101AB1" })),
      buildEntityFingerprint(org({ orgId: "org-2", orgName: "Dos", rfc: "BBB020202CD2" })),
    ];
    expect(findInterpositaPersonaCandidates(fingerprints)).toEqual([]);
  });

  it("respeta un threshold custom más alto", () => {
    const shared = { domicilio: { addressLine: "Calle X 1", city: "GDL", state: "JAL", postalCode: "44100" } };
    const fingerprints = [
      buildEntityFingerprint(org({ orgId: "org-1", orgName: "Uno", ...shared })),
      buildEntityFingerprint(org({ orgId: "org-2", orgName: "Dos", ...shared })),
    ];
    expect(findInterpositaPersonaCandidates(fingerprints, { threshold: 0.5 })).toEqual([]);
    expect(findInterpositaPersonaCandidates(fingerprints, { threshold: 0.3 })).toHaveLength(1);
  });
});
