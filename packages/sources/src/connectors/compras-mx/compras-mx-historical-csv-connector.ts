import type { ConnectorContext, DiscoverParams, SourceConnector } from "../types.js";
import { decodeByteChunksStream, extractCharset } from "../../util/encoding.js";
import { assertLegitimateResponseBody } from "../../http/response-classifier.js";
import { parseComprasMxHistoricoCsvStreamed } from "./comprasmx-mapper.js";

/**
 * Adapta el cuerpo de una `Response` a un `AsyncIterable<Uint8Array>` sin
 * bufferear nunca el cuerpo completo (memoria acotada, ronda 3 de
 * corrección): `response.body` (spec WHATWG `ReadableStream`) ya es
 * async-iterable en Node/undici, así que se usa directamente. Fallback a
 * `arrayBuffer()` (un solo chunk) SOLO si el runtime no expone `.body` como
 * stream -- caso excepcional, no se espera en producción (fetch real de
 * Node siempre lo expone para una respuesta 200 con contenido).
 */
async function* iterateResponseBodyBytes(response: Response): AsyncGenerator<Uint8Array> {
  if (response.body) {
    yield* response.body as unknown as AsyncIterable<Uint8Array>;
    return;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 0) yield new Uint8Array(buffer);
}

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
 * STREAMING (ronda 3 de corrección, ver README §Robustez del CSV histórico):
 * `discover()` YA NO descarga el CSV completo en memoria. Consume
 * `response.body` byte a byte (`iterateResponseBodyBytes`), decodifica en
 * streaming (`decodeByteChunksStream`, charset declarado/BOM/heurística
 * UTF-8-Latin1/UTF-16LE -- ver `util/encoding.ts`) y parsea fila por fila
 * (`parseComprasMxHistoricoCsvStreamed`), produciendo cada `TenderRecord`
 * tan pronto como su fila está completa. La memoria retenida es
 * proporcional al lote/chunk en curso, NO al tamaño del archivo -- medido
 * con un test de 50 MB simulados (ver `test/csv-streaming-memory.test.ts`).
 * Límite real aceptado y documentado: la detección de captcha/bot-challenge
 * (SR-14) y la elección de encoding corren sobre el PRIMER chunk decodificado
 * (hasta ~64 KiB), no sobre el archivo completo -- suficiente en la práctica
 * porque un bloqueo real es una página HTML pequeña completa, y el encoding
 * real no cambia a mitad de una misma respuesta; UTF-16BE SIN BOM en el
 * cuerpo tampoco se detecta en esta ruta en streaming (sí en
 * `decodeBestEffort`, usado por conectores que no necesitan streaming) --
 * ver README para el detalle completo.
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
      const fetchedAt = ctx.now?.() ?? new Date();
      // SR-15: decodifica por bytes crudos (charset declarado / BOM / heurística UTF-8-Latin1/UTF-16, ver
      // `util/encoding.ts`) en vez de `response.text()`, que decodifica SIEMPRE como UTF-8. Streaming (ronda 3):
      // NUNCA concatena el cuerpo completo, a diferencia de `decodeHttpResponseText`/`response.text()`.
      const declaredCharset = extractCharset(response.headers.get("content-type"));
      const decodedChunks = decodeByteChunksStream(iterateResponseBodyBytes(response), declaredCharset);

      let checkedFirstChunk = false;
      const validatedChunks = (async function* () {
        for await (const textChunk of decodedChunks) {
          if (!checkedFirstChunk) {
            checkedFirstChunk = true;
            // SR-14: un 200 con cuerpo de captcha/bot-challenge (o con forma de HTML donde se esperaba CSV) no
            // debe interpretarse como "0 registros nuevos". Se verifica el PRIMER chunk decodificado (memoria
            // acotada, ver docstring de la función) -- un bloqueo real es una página HTML pequeña COMPLETA.
            assertLegitimateResponseBody(textChunk, { url: csvUrl, expected: "csv" });
          }
          yield textChunk;
        }
        if (!checkedFirstChunk) {
          assertLegitimateResponseBody("", { url: csvUrl, expected: "csv" }); // cuerpo vacío: se valida igual, nunca se salta la verificación.
        }
      })();

      let yielded = 0;
      for await (const event of parseComprasMxHistoricoCsvStreamed(validatedChunks, {
        sourceUrl: csvUrl,
        fetchedAt,
        httpStatus: response.status,
        publishingEntity,
      })) {
        if (event.kind === "error") {
          // SR-16/17: filas inválidas o desalineadas se registran (con su número de fila) sin perder el resto del
          // lote; se hacen visibles vía el logger Y vía `ctx.reportDropped` (SR-21) en vez de silenciarlas.
          ctx.logger?.warn(`CSV histórico de ComprasMX: fila ${event.error.row} descartada — ${event.error.message}`, {
            source: "compras-mx-historico",
            row: event.error.row,
          });
          ctx.reportDropped?.({ index: event.error.row - 1, reason: event.error.message });
          continue;
        }
        if (params.limit !== undefined && yielded >= params.limit) return;
        yield event.record;
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
