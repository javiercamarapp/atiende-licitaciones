import { describe, it, expect } from "vitest";
import { CrossTenantSimilarityDetector, InMemoryFingerprintStore, ALGORITHM_VERSION } from "../../src/similarity/cross-tenant-detector.js";

const PLANTILLA =
  "La empresa cuenta con amplia experiencia en la construcción de obra pública para gobiernos estatales y municipales, " +
  "con un equipo técnico certificado y maquinaria propia disponible para el cumplimiento oportuno de los plazos contractuales establecidos.";

describe("CrossTenantSimilarityDetector (REQ-032)", () => {
  it("CASO POSITIVO: dos tenants distintos con la MISMA plantilla -> flagged=true, similitud por encima del umbral, y se registra el evento de cumplimiento", async () => {
    const store = new InMemoryFingerprintStore();
    const detector = new CrossTenantSimilarityDetector(store);

    const orgA = "org-a";
    const orgB = "org-b";
    const tenderA = "tender-1";
    const tenderB = "tender-2";

    const first = await detector.assess(PLANTILLA + " Referencia: Municipio de Querétaro.", { orgId: orgA, tenderId: tenderA, sectionKey: "experiencia" });
    expect(first.flagged).toBe(false); // primer tenant en registrar esta plantilla: nada con qué compararse todavía

    const second = await detector.assess(PLANTILLA + " Referencia: Municipio de Toluca.", { orgId: orgB, tenderId: tenderB, sectionKey: "experiencia" });
    expect(second.flagged).toBe(true);
    expect(second.similarity).toBeGreaterThanOrEqual(0.75);

    expect(store.flags).toHaveLength(1);
    expect(store.flags[0]).toMatchObject({
      orgId: orgB,
      tenderId: tenderB,
      sectionKey: "experiencia",
      matchedOrgId: orgA,
      matchedTenderId: tenderA,
      matchedSectionKey: "experiencia",
      regenerated: false,
    });
  });

  it("CASO NEGATIVO (adversarial): dos tenants con contenido genuinamente distinto -> flagged=false, sin evento de cumplimiento", async () => {
    const store = new InMemoryFingerprintStore();
    const detector = new CrossTenantSimilarityDetector(store);

    await detector.assess(
      "Nuestra compañía ha ejecutado quince proyectos de pavimentación asfáltica en Jalisco durante ocho años con maquinaria propia.",
      { orgId: "org-a", tenderId: "t1", sectionKey: "experiencia" },
    );
    const result = await detector.assess(
      "El despacho cuenta con especialistas en instalaciones eléctricas de media tensión para plantas industriales en Guanajuato.",
      { orgId: "org-b", tenderId: "t2", sectionKey: "experiencia" },
    );

    expect(result.flagged).toBe(false);
    expect(store.flags).toHaveLength(0);
  });

  it("nunca compara un tenant contra SU PROPIA huella anterior como si fuera colusión entre tenants", async () => {
    const store = new InMemoryFingerprintStore();
    const detector = new CrossTenantSimilarityDetector(store);

    await detector.assess(PLANTILLA, { orgId: "org-a", tenderId: "t1", sectionKey: "experiencia" });
    // Mismo org, mismo texto, otra convocatoria: no es "entre tenants" -- nunca debe marcarse.
    const result = await detector.assess(PLANTILLA, { orgId: "org-a", tenderId: "t2", sectionKey: "experiencia" });

    expect(result.flagged).toBe(false);
    expect(store.flags).toHaveLength(0);
  });

  it("secciones vacías (bloqueadas por falta de evidencia) nunca se marcan como plantilla compartida", async () => {
    const store = new InMemoryFingerprintStore();
    const detector = new CrossTenantSimilarityDetector(store);

    await detector.assess("", { orgId: "org-a", tenderId: "t1", sectionKey: "experiencia" });
    const result = await detector.assess("", { orgId: "org-b", tenderId: "t2", sectionKey: "experiencia" });

    expect(result.flagged).toBe(false);
    expect(store.flags).toHaveLength(0);
  });

  it("el evento de cumplimiento registra `regenerated` tal como lo pasa el llamador (aviso tras reintento fallido)", async () => {
    const store = new InMemoryFingerprintStore();
    const detector = new CrossTenantSimilarityDetector(store);

    await detector.assess(PLANTILLA, { orgId: "org-a", tenderId: "t1", sectionKey: "experiencia" });
    await detector.assess(PLANTILLA, { orgId: "org-b", tenderId: "t2", sectionKey: "experiencia" }, { regenerated: true });

    expect(store.flags[0].regenerated).toBe(true);
  });

  it("respeta la versión del algoritmo declarada al persistir la huella", async () => {
    const store = new InMemoryFingerprintStore();
    const detector = new CrossTenantSimilarityDetector(store);
    await detector.assess(PLANTILLA, { orgId: "org-a", tenderId: "t1", sectionKey: "experiencia" });
    expect(store.fingerprints[0].algorithmVersion).toBe(ALGORITHM_VERSION);
  });

  it("un umbral configurado más estricto exige mayor similitud para marcar", async () => {
    const store = new InMemoryFingerprintStore();
    const detector = new CrossTenantSimilarityDetector(store, { threshold: 0.99 });

    await detector.assess(PLANTILLA + " Folio A.", { orgId: "org-a", tenderId: "t1", sectionKey: "experiencia" });
    const result = await detector.assess(PLANTILLA + " Folio B distinto y más largo para variar el conteo de shingles.", {
      orgId: "org-b",
      tenderId: "t2",
      sectionKey: "experiencia",
    });

    expect(result.flagged).toBe(false);
  });
});
