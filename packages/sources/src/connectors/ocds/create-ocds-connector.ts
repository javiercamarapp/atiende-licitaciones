import type { ConnectorContext, DiscoverParams, LiveVerification, SourceConnector } from "../types.js";
import type { SourceId } from "../../types/tender-record.js";
import { assertLegitimateResponseBody } from "../../http/response-classifier.js";
import { mapOcdsPackageToTenderRecords, mapOcdsReleaseToTenderRecord } from "./ocds-mapper.js";
import { OcdsReleaseSchema } from "./ocds-types.js";

export interface OcdsConnectorConfig {
  id: SourceId;
  termsNote: string;
  liveVerification: LiveVerification;
  /** Construye la URL de listado (release package paginado) a partir de los parámetros de descubrimiento. */
  buildListUrl(params: DiscoverParams): string;
  /** Construye la URL de detalle de un solo procedimiento, si la fuente la expone. */
  buildDetailUrl?(externalId: string): string;
  /** Extrae el cursor de la siguiente página del JSON crudo devuelto (paginación específica de la fuente). */
  extractNextCursor?(rawJson: unknown): string | undefined;
  /** Entidad federativa por defecto cuando la fuente representa un único portal estatal (REQ-135). */
  defaultState?: string;
}

/**
 * Fábrica de conectores para cualquier fuente que exponga el patrón
 * compartido "release package OCDS 1.1 paginado" (SHCP, PDN Sistema 6, y
 * portales estatales `/edca/...` — REQ-133/REQ-135). Evita duplicar el
 * ciclo de paginación/mapeo en cada conector; solo cambia cómo se construyen
 * las URLs y se extrae el cursor siguiente.
 */
export function createOcdsConnector(config: OcdsConnectorConfig): SourceConnector {
  return {
    id: config.id,
    termsNote: config.termsNote,
    liveVerification: config.liveVerification,

    async *discover(params: DiscoverParams, ctx: ConnectorContext) {
      let cursor = params.cursor;
      let yielded = 0;
      const limit = params.limit;

      // Evita loops infinitos si una fuente mal configurada repite el mismo cursor.
      const seenCursors = new Set<string>();

      for (;;) {
        const url = config.buildListUrl({ ...params, cursor });
        const response = await ctx.http.request(url);
        if (!response.ok) {
          throw new Error(`Fuente ${config.id} respondió ${response.status} en ${url}`);
        }
        const bodyText = await response.text();
        // SR-14: un 200 con cuerpo de captcha/bot-challenge (o con forma de página HTML donde se esperaba JSON)
        // no debe interpretarse como "0 registros nuevos" -- ver README (Zenedge documentado para PDN-S6).
        assertLegitimateResponseBody(bodyText, { url, expected: "json" });
        const json = JSON.parse(bodyText);
        const fetchedAt = ctx.now?.() ?? new Date();
        const { records, dropped } = mapOcdsPackageToTenderRecords(json, {
          source: config.id,
          sourceUrl: url,
          fetchedAt,
          httpStatus: response.status,
          defaultState: config.defaultState,
        });
        // SR-24: ningún release descartado (esquema OCDS inválido, o sin bloque `tender`) desaparece en silencio --
        // se reenvía al pipeline vía `ctx.reportDropped` para que quede en `errores`/`dropped` y cuente hacia el
        // umbral de tasa de descarte (`dropRateThreshold`), igual que ya hace `createComprasMxConnector` (SR-21).
        for (const info of dropped) ctx.reportDropped?.(info);

        const nextCursor = config.extractNextCursor?.(json);

        for (let i = 0; i < records.length; i += 1) {
          if (limit !== undefined && yielded >= limit) return;
          const isLastOfPage = i === records.length - 1;
          yield isLastOfPage ? { ...records[i], sourceCursor: nextCursor } : records[i];
          yielded += 1;
        }

        if (!nextCursor || seenCursors.has(nextCursor) || (limit !== undefined && yielded >= limit)) {
          return;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    },

    async fetchDetail(externalId: string, ctx: ConnectorContext) {
      if (!config.buildDetailUrl) {
        throw new Error(`Fuente ${config.id} no expone endpoint de detalle individual verificado.`);
      }
      const url = config.buildDetailUrl(externalId);
      const response = await ctx.http.request(url);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Fuente ${config.id} respondió ${response.status} en ${url}`);
      }
      const bodyText = await response.text();
      assertLegitimateResponseBody(bodyText, { url, expected: "json" });
      const json = JSON.parse(bodyText);
      const fetchedAt = ctx.now?.() ?? new Date();
      const release = OcdsReleaseSchema.parse(json);
      return mapOcdsReleaseToTenderRecord(release, json, {
        source: config.id,
        sourceUrl: url,
        fetchedAt,
        httpStatus: response.status,
        defaultState: config.defaultState,
      });
    },
  };
}
