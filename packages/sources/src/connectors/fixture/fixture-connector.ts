import type { ConnectorContext, DiscoverParams, SourceConnector } from "../types.js";
import type { TenderRecord } from "../../types/tender-record.js";
import { hashRawPayload } from "../../util/hash.js";
import { addDaysUtc } from "../../util/timezone.js";

export interface FixtureOfflineConnectorConfig {
  /**
   * Convocatorias sintéticas a producir. Por defecto usa
   * `DEFAULT_FIXTURE_TENDERS` (abajo) -- 2 convocatorias de ejemplo,
   * claramente marcadas `[SINTÉTICO]` en cada campo de texto libre, para que
   * nunca puedan confundirse con una convocatoria real capturada de una
   * fuente verdadera.
   */
  tenders?: FixtureTenderInput[];
  /** Reloj inyectable para pruebas deterministas; por defecto `() => new Date()`. */
  now?: () => Date;
}

export interface FixtureTenderInput {
  externalId: string;
  title: string;
  contractingEntity: string;
  cpvCodes?: string[];
  budgetAmount?: number;
}

/**
 * REQ-070 (Orquestador Radar→Analista→Redactor→Auditor→Mensajero): B-02
 * (docs/BLOQUEOS.md) sigue ABIERTO -- ComprasMX/OCDS-SHCP/DOF/PDN-S6/
 * portales estatales (los 5 conectores reales de `buildDefaultConnectorRegistry()`
 * en `apps/worker/src/handlers/discover-tenders.ts`) siguen bloqueados o sin
 * verificación en vivo, así que el tramo "Radar" del grafo de orquestación
 * NO puede probarse de punta a punta contra un servicio real todavía.
 *
 * Este conector es la pieza ROTULADA explícitamente como falsa que permite
 * probar el GRAFO COMPLETO (Radar→Analista→Redactor→Auditor→Mensajero)
 * mientras eso sigue bloqueado -- "esqueleto honesto": el PUERTO real
 * (`SourceConnector`, el mismo contrato que usan los 5 conectores reales) +
 * datos SINTÉTICOS explícitos (nunca convocatorias reales copiadas o
 * inventadas como si lo fueran) + `liveVerification.verified: false` +
 * `liveVerification.synthetic: true` (nunca se finge una verificación real
 * que no existe -- ver docstring de `LiveVerification.synthetic` en
 * `../types.ts`).
 *
 * NUNCA debe registrarse en `buildDefaultConnectorRegistry()` (el registro
 * de producción): solo lo registran explícitamente pruebas/scripts de
 * orquestación que lo pidan por su propio id (`fixture-offline`).
 */
export function createFixtureOfflineConnector(config: FixtureOfflineConnectorConfig = {}): SourceConnector {
  const now = config.now ?? (() => new Date());
  const tenders = config.tenders ?? DEFAULT_FIXTURE_TENDERS;

  return {
    id: "fixture-offline",
    termsNote:
      "No aplica: este conector nunca hace una petición HTTP real a ningún servicio. Produce únicamente los registros " +
      "sintéticos declarados en `config.tenders` (o `DEFAULT_FIXTURE_TENDERS`).",
    liveVerification: {
      verified: false,
      synthetic: true,
      note:
        "Conector sintético/offline de pruebas (REQ-070): no representa ninguna fuente real y por lo tanto nunca fue " +
        "-ni podrá ser- verificado contra un servicio en producción. verificado_contra_real=false de forma permanente " +
        "e intencional. El acceso real a ComprasMX/DOF/OCDS-SHCP/PDN-S6/portales estatales sigue bloqueado por B-02 " +
        "(docs/BLOQUEOS.md) -- este conector NO es, ni sustituye a, ese trabajo pendiente.",
    },
    async *discover(params: DiscoverParams, _ctx: ConnectorContext) {
      const fetchedAt = now();
      let yielded = 0;
      for (const t of tenders) {
        if (params.limit !== undefined && yielded >= params.limit) return;
        yield buildFixtureRecord(t, fetchedAt);
        yielded += 1;
      }
    },
    async fetchDetail(externalId: string) {
      const match = tenders.find((t) => t.externalId === externalId);
      if (!match) return null;
      return buildFixtureRecord(match, now());
    },
  };
}

function buildFixtureRecord(input: FixtureTenderInput, fetchedAt: Date): TenderRecord {
  return {
    source: "fixture-offline",
    externalId: input.externalId,
    title: `[SINTÉTICO] ${input.title}`,
    contractingEntity: `[SINTÉTICO] ${input.contractingEntity}`,
    procedureType: "licitacion_publica",
    procedureTypeRaw: "licitación pública (fixture)",
    classifiers: (input.cpvCodes ?? []).map((code) => ({ scheme: "CPV" as const, code })),
    budgetAmount: input.budgetAmount,
    currency: "MXN",
    dates: {
      published: fetchedAt,
      // SR-12 (test/tz-invariant.test.ts): ningún conector construye
      // `new Date(<epoch>)` directo — `addDaysUtc` (util/timezone.ts) hace
      // la misma aritmética de forma centralizada y auditada.
      submissionDeadline: addDaysUtc(fetchedAt, 30),
    },
    status: "published",
    statusRaw: "publicada (fixture)",
    attachments: [],
    snapshot: {
      fetchedAt,
      rawHash: hashRawPayload({ fixture: true, externalId: input.externalId, title: input.title }),
    },
  };
}

/**
 * Convocatorias sintéticas de ejemplo (nunca datos reales de ninguna
 * dependencia mexicana): un caso "encaja bien" (obra civil) y uno "encaja
 * mal" (servicios de TI), suficientes para ejercitar `proponer_matching`
 * (`apps/worker/src/agents/business-tools.ts`) con una señal real (aunque
 * sobre datos sintéticos).
 */
export const DEFAULT_FIXTURE_TENDERS: FixtureTenderInput[] = [
  {
    externalId: "FIXTURE-0001",
    title: "Rehabilitación de pavimento en vialidad secundaria (caso de prueba REQ-070)",
    contractingEntity: "Dependencia de prueba A",
    cpvCodes: ["45233142"],
    budgetAmount: 1_500_000,
  },
  {
    externalId: "FIXTURE-0002",
    title: "Suministro de licencias de software de oficina (caso de prueba REQ-070)",
    contractingEntity: "Dependencia de prueba B",
    cpvCodes: ["48000000"],
    budgetAmount: 300_000,
  },
];
