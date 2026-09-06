import type { ConnectorContext, DiscoverParams, SourceConnector } from "../types.js";
import { decodeHttpResponseText } from "../../util/encoding.js";
import { assertLegitimateResponseBody } from "../../http/response-classifier.js";
import { parseComprasMxHistoricoCsv } from "./comprasmx-mapper.js";

export interface ComprasMxHistoricalCsvConnectorConfig {
  /** URL del CSV histórico real de la SABG (dataset abierto CKAN, sin reCAPTCHA/auth). */
  csvUrl?: string;
  /** Nombre de la entidad publicadora a usar como `contractingEntity` (el CSV no trae columna de dependencia/entidad convocante, ver `comprasmx-mapper.ts`). */
  publishingEntity?: string;
}

const DEFAULT_CSV_URL =
  "https://repodatos.atdt.gob.mx/api_update/sabg/contratos_expedientes_sistema_historico_compranet/compranet_historico.csv";
const DEFAULT_PUBLISHING_ENTITY = "Secretaría Anticorrupción y Buen Gobierno (dataset histórico Compranet)";

/**
 * Conector del CSV histórico REAL de contratos de CompraNet (SR-06). A
 * diferencia de `createComprasMxConnector()` (bloqueado por reCAPTCHA, ver
 * README §ComprasMX), este dataset abierto (CKAN, `datos.gob.mx`, sin
 * reCAPTCHA/auth) fue verificado en vivo el 2026-09-05
 * (`content-length: 951619345` / `last-modified: 2025-07-03`, ver README) y
 * `parseComprasMxHistoricoCsv()` ya lo parseaba correctamente, pero nunca
 * estaba envuelto en un `SourceConnector` real: ninguna corrida del
 * `DiscoveryPipeline` lo consumía pese a existir una integración 100%
 * verificada.
 *
 * IMPORTANTE — declarado explícitamente como fuente HISTÓRICA, no de
 * descubrimiento en vivo: es un dataset de CONTRATOS YA CONCLUIDOS
 * (2010-2022), no de convocatorias abiertas nuevas. Se registra con su
 * propio `SourceId` (`compras-mx-historico`) precisamente para que ningún
 * consumidor lo confunda con el conector de convocatorias abiertas
 * (`compras-mx`) ni asuma que sus registros representan oportunidades
 * vigentes (todos se mapean con `status: "awarded"`, ver
 * `parseComprasMxHistoricoCsv`).
 *
 * LIMITACIÓN CONOCIDA (no resuelta en esta ronda, documentada honestamente):
 * el dataset real pesa ~951 MB; esta implementación descarga el CSV
 * completo en memoria vía `response.text()`. Para producción contra el
 * archivo real se recomienda un parser en streaming (fuera de alcance:
 * ver README §Pendientes).
 */
export function createComprasMxHistoricalCsvConnector(config: ComprasMxHistoricalCsvConnectorConfig = {}): SourceConnector {
  const csvUrl = config.csvUrl ?? DEFAULT_CSV_URL;
  const publishingEntity = config.publishingEntity ?? DEFAULT_PUBLISHING_ENTITY;

  return {
    id: "compras-mx-historico",
    termsNote:
      "Dataset abierto CKAN de datos.gob.mx (SABG), sin reCAPTCHA ni autenticación, verificado en vivo el 2026-09-05 " +
      "(HEAD real: content-length 951619345 bytes, last-modified 2025-07-03). Solo lectura (GET/HEAD), sin límites " +
      "de tasa documentados distintos del límite general de REQ-079.",
    liveVerification: {
      verified: true,
      note:
        "2026-09-05: HEAD sobre la URL del CSV histórico -> 200, content-length: 951619345 (≈951 MB), " +
        "last-modified: 2025-07-03. Fixture real (primeras filas) en " +
        "test/fixtures/compras-mx/compranet-historico-real-sample.csv, parseado sin errores por " +
        "parseComprasMxHistoricoCsv (ver test/connectors/compras-mx-historical.test.ts). Es historial de contratos " +
        "YA CONCLUIDOS (2010-2022), no convocatorias abiertas — declarado explícitamente como fuente histórica, no " +
        "de descubrimiento en vivo.",
    },

    async *discover(params: DiscoverParams, ctx: ConnectorContext) {
      const response = await ctx.http.request(csvUrl);
      if (!response.ok) {
        throw new Error(`CSV histórico de ComprasMX respondió ${response.status} en ${csvUrl}`);
      }
      // SR-15: decodifica por bytes crudos (charset declarado / BOM / heurística UTF-8 inválido -> Latin-1) en vez
      // de `response.text()`, que decodifica SIEMPRE como UTF-8 sin importar el charset real del servidor.
      const csvText = await decodeHttpResponseText(response);
      // SR-14: un 200 con cuerpo de captcha/bot-challenge (o con forma de HTML donde se esperaba CSV) no debe
      // interpretarse como "0 registros nuevos".
      assertLegitimateResponseBody(csvText, { url: csvUrl, expected: "csv" });
      const fetchedAt = ctx.now?.() ?? new Date();
      const { records, errors } = parseComprasMxHistoricoCsv(csvText, {
        sourceUrl: csvUrl,
        fetchedAt,
        httpStatus: response.status,
        publishingEntity,
      });

      // SR-16/17: filas inválidas o desalineadas se registran (con su número de fila) sin perder el resto del
      // lote; se hacen visibles vía el logger del pipeline en vez de silenciarlas.
      for (const rowError of errors) {
        ctx.logger?.warn(`CSV histórico de ComprasMX: fila ${rowError.row} descartada — ${rowError.message}`, {
          source: "compras-mx-historico",
          row: rowError.row,
        });
      }

      let yielded = 0;
      for (const record of records) {
        if (params.limit !== undefined && yielded >= params.limit) return;
        yield record;
        yielded += 1;
      }
    },

    async fetchDetail() {
      throw new Error(
        "ComprasMxHistoricalCsvConnector.fetchDetail no está implementado: el dataset histórico es un volcado " +
          "CSV masivo sin endpoint de detalle por expediente/contrato individual.",
      );
    },
  };
}
