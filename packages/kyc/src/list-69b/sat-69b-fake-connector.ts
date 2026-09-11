/**
 * Doble FAKE explícito del conector de la lista 69-B, para pruebas (propias
 * y de consumidores como `apps/worker`/`apps/api`) — nunca se mockea la
 * lógica de negocio de este paquete (clasificación de riesgo, parseo,
 * fingerprint), solo el borde externo (la descarga HTTP real). Por
 * defecto, sin argumentos, carga y parsea el fixture REAL descargado en
 * vivo (`test/fixtures/sat-69b/listado-real-sample.csv`, 30 filas reales
 * de las ~14,200 del archivo completo) con el MISMO parser real
 * (`parseSat69BCsvText`) que usa el conector HTTP -- así una prueba contra
 * este fake sigue ejercitando la lógica de parseo real, solo sustituye la
 * descarga de red.
 *
 * `liveVerification.verified` es SIEMPRE `false` aquí, sin importar qué
 * tan real sea el fixture: solo el conector HTTP real
 * (`sat-69b-http-connector.ts`) puede declarar `verified: true`, y solo
 * porque de verdad hizo la petición contra el servicio en producción.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeBestEffort, sha256Hex } from "@atiende/sources";
import { parseSat69BCsvText } from "./parse-sat-69b-csv.js";
import type { NegativeListConnector, NegativeListEntry, NegativeListFetchContext, NegativeListSnapshot } from "../types.js";

const REAL_FIXTURE_PATH = fileURLToPath(new URL("../../test/fixtures/sat-69b/listado-real-sample.csv", import.meta.url));

export interface FakeSat69BConnectorOptions {
  /** Entradas a devolver en vez de las del fixture real (para probar un RFC específico sin depender del contenido del fixture). */
  entries?: NegativeListEntry[];
  listAsOfDate?: string | null;
  sourceUrl?: string;
  /** Si se define, `fetchSnapshot()` rechaza con este error en vez de devolver un snapshot (para probar manejo de fallas). */
  failWith?: Error;
}

export function createFakeSat69BConnector(options: FakeSat69BConnectorOptions = {}): NegativeListConnector {
  const sourceUrl = options.sourceUrl ?? "fake://sat-69b/fixture";

  return {
    listId: "sat_69b",
    liveVerification: {
      verified: false,
      note: "Doble fake para pruebas: nunca hace una petición de red real. Ver JSDoc de este archivo.",
    },
    async fetchSnapshot(ctx?: NegativeListFetchContext): Promise<NegativeListSnapshot> {
      if (options.failWith) throw options.failWith;
      const now = ctx?.now ?? (() => new Date());

      if (options.entries) {
        return {
          listId: "sat_69b",
          sourceUrl,
          fetchedAt: now(),
          listAsOfDate: options.listAsOfDate ?? null,
          listAsOfRaw: options.listAsOfDate ? `Información actualizada al ${options.listAsOfDate} (fake)` : null,
          entries: options.entries,
          rawHash: sha256Hex(JSON.stringify(options.entries)),
        };
      }

      const rawBytes = readFileSync(REAL_FIXTURE_PATH);
      const rawText = decodeBestEffort(new Uint8Array(rawBytes));
      const parsed = parseSat69BCsvText(rawText);
      return {
        listId: "sat_69b",
        sourceUrl,
        fetchedAt: now(),
        listAsOfDate: parsed.listAsOfDate,
        listAsOfRaw: parsed.listAsOfRaw,
        listAsOfParseError: parsed.listAsOfParseError,
        entries: parsed.entries,
        rawHash: sha256Hex(rawText),
      };
    },
  };
}
