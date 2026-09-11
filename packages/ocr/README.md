# @atiende/ocr

Puerto de OCR de **Atiende Licitaciones** (REQ-014, REQ-018, REQ-129,
`docs/REQUISITOS.md` §4/§26). Librería TypeScript **pura** (sin dependencia
de `apps/api`/`apps/worker` ni de ninguna base de datos): mismo criterio que
`packages/mail` y `packages/sources` -- aquí solo viven el contrato
(`OcrPort`) y sus implementaciones; quien consuma este paquete decide CUÁNDO
invocar OCR y qué hacer con el resultado.

## Qué NO es este paquete

- **No es el pipeline completo que pide REQ-018.** REQ-018 exige, literal:
  *"Nunca usar Tesseract como único OCR; pipeline Docling/PyMuPDF (nativo) +
  Mistral OCR/Azure Layout (escaneos) + visión LLM solo por excepción"*.
  Ese pipeline requiere credenciales de proveedor (Mistral OCR o Azure
  Document Intelligence) que este repo **no tiene y nunca fabrica**. Lo que
  este paquete SÍ construye es el `OcrPort` -- el contrato agnóstico de motor
  que hace posible agregar esos adaptadores reales el día que exista la
  credencial, sin tocar ningún consumidor. Hoy el único adaptador real es
  `TesseractOcrAdapter` (motor local, sin credencial). Por eso
  `createOcrPortFromEnv()` **nunca** lo activa por defecto -- solo con
  `OCR_ENGINE=tesseract` explícito (ver abajo): usarlo como el único OCR de
  producción sin ese paso explícito violaría la letra de REQ-018.
- **No rasteriza PDFs a imágenes.** `OcrPort.recognize()` toma una imagen
  (PNG/JPEG/...) de UNA página, nunca un PDF. `apps/api` ya clasifica nativo
  vs. escaneado en `lib/expediente/text-extraction.ts` (columna
  `text_extraction_status`, estado `requires_ocr` cuando un PDF no tiene capa
  de texto) -- ese módulo ahora acepta un `OcrPort` opcional y lo usa para
  **imágenes sueltas** (foto/escaneo de una página subida como PNG/JPEG). La
  pieza que falta para cerrar el caso "PDF escaneado de varias páginas" es
  rasterizar cada página a imagen (p. ej. `pdfjs-dist` + `@napi-rs/canvas`) --
  **deliberadamente fuera de esta ronda**: es una pieza de superficie propia
  (con su propio riesgo tipo "PDF bomb", igual que AE-05/R6-11 en
  `text-extraction.ts`) que merece su propia ronda de hardening, no colarse
  como efecto secundario de construir el puerto de OCR. Ver
  `docs/ACEPTACION.md` REQ-014/018/129 para el estado exacto.
- **No tiene gold set de licitaciones reales.** No existe en este repo un
  conjunto de documentos ESCANEADOS reales de una licitación mexicana contra
  el que medir precisión de texto/bbox (el mismo hueco que documenta
  REQ-021). `TesseractOcrAdapter.liveVerification.verified` es `false` de
  forma explícita por esto -- el motor SÍ se probó de verdad (no un mock)
  contra imágenes generadas en esta sesión, pero eso no sustituye un
  benchmark contra OmniDocBench (el criterio literal de REQ-018) ni un
  gold set real (REQ-014).

## Arquitectura

```
src/
  types.ts              OcrPort, OcrInput, OcrResult, OcrPageResult/OcrLine/OcrWord,
                         LiveVerification, OcrNotConfiguredError
  tesseract-adapter.ts   TesseractOcrAdapter -- motor REAL (tesseract.js), 100% local
  fake-adapter.ts        FakeOcrAdapter -- para pruebas del CONSUMIDOR del puerto, nunca
                         para probar que el OCR en sí funciona
  factory.ts             createOcrPortFromEnv() -- OCR_ENGINE decide cuál (default: fake)
test/
  tesseract-adapter.test.ts   Motor REAL contra imágenes generadas en la propia prueba
  fake-adapter.test.ts        FakeOcrAdapter
  factory.test.ts             createOcrPortFromEnv
  fixtures/lang-data/spa.traineddata   Modelo oficial de Tesseract para español ("tessdata_fast",
                                       Apache 2.0, proyecto tesseract-ocr) -- empaquetado para que
                                       la suite corra determinística y SIN RED; ver licencia abajo
  support/render-text-image.ts        Genera el PNG de prueba (NO es un documento real de licitación)
```

## `TesseractOcrAdapter`: el adaptador real

- Motor: [`tesseract.js`](https://github.com/naptha/tesseract.js) (Tesseract
  OCR compilado a WASM). Corre **enteramente en este proceso Node**, sin
  llamar a ningún servicio externo ni requerir API key -- el requisito
  explícito de la tarea ("librería OCR que corra localmente sin credencial
  externa").
- **Primera ejecución sin `langPath` local**: tesseract.js descarga el modelo
  de idioma (`<idioma>.traineddata`, unos pocos MB) de su CDN pública
  (`tessdata.projectnaptha.com`) -- una descarga pública sin autenticar, NO
  una credencial de API, pero SÍ requiere salida a Internet la primera vez.
  Para pruebas/CI sin red, pasar `langPath` apuntando a una carpeta con el
  `.traineddata` ya presente (`gzip: false`, ver
  `test/fixtures/lang-data/`).
- Idioma por defecto: `"spa"` (español) -- el idioma real de toda licitación
  pública mexicana. Un adaptador queda fijo a UN idioma durante su vida
  (reinicializar el worker por llamada tendría un costo de segundos que no
  se quiere ocultar); para varios idiomas, crear un adaptador por idioma.
- Devuelve texto + bounding boxes REALES a nivel de palabra y línea
  (`OcrPageResult.lines[].words[].bbox`), con confianza (0-100) por palabra y
  el promedio de la página -- el material que REQ-014 pide ("texto con
  layout + bounding box").
- `liveVerification.verified = false` explícito -- ver "Qué NO es este
  paquete" arriba.

## `FakeOcrAdapter`: el adaptador de pruebas

Nunca ejecuta reconocimiento óptico real -- mismo criterio que
`CaptureProvider` de `packages/mail`: se mockea el BORDE externo (el motor
OCR), nunca la lógica de negocio de quien consume el puerto. Acepta un
`respond` fijo o una función del `OcrInput`, y registra cada llamada en
`.calls` para que un test verifique qué imagen/idioma se le pasó.

## `createOcrPortFromEnv`: cómo lo activa `apps/api`/`apps/worker`

```ts
import { createOcrPortFromEnv } from "@atiende/ocr";

const ocr = createOcrPortFromEnv(process.env);
// Sin OCR_ENGINE=tesseract explícito: FakeOcrAdapter -- ninguna llamada real,
// ningún costo de CPU/memoria ni descarga de red por accidente.
```

| Variable | Uso | Default |
|---|---|---|
| `OCR_ENGINE` | `tesseract` \| cualquier otro valor/ausente | `fake` (nunca activa el motor real por accidente) |
| `OCR_LANGUAGE` | Código de idioma de Tesseract (3 letras) | `spa` |
| `OCR_LANG_PATH` | Carpeta local con `<idioma>.traineddata` sin gzip, para evitar la descarga de red | sin fijar (usa la CDN pública de tesseract.js) |
| `OCR_CACHE_PATH` | Carpeta de caché del modelo entre llamadas | sin fijar (default de tesseract.js) |

**Activación en producción: PENDIENTE de una decisión operativa explícita**,
no de una credencial -- `TesseractOcrAdapter` ya funciona sin que nadie
aporte nada. Lo que falta es decidir (a) si vale la pena activarlo como
`OCR_ENGINE=tesseract` para el caso "imagen suelta" mientras no exista
Mistral OCR/Azure Layout para el caso "PDF escaneado" (REQ-018 exige que
Tesseract nunca sea el ÚNICO OCR de producción, así que activarlo hoy en
`apps/api` sin plan de agregar un segundo motor sería, en espíritu,
incumplir ese requisito aunque el código lo permita), y (b) construir la
rasterización de PDF descrita arriba. Documentado como bloqueo de decisión,
no de código.

## Integración con `apps/api`

`apps/api/src/lib/expediente/text-extraction.ts` (`extractDocumentText`)
acepta un tercer parámetro opcional `ocr?: OcrPort`. Sin él (el caso de HOY
en los dos únicos call sites reales, `documents.routes.ts` y
`contract.routes.ts`), el comportamiento es EXACTAMENTE el de antes de este
paquete: un PDF sin capa de texto sigue devolviendo `requires_ocr` explícito,
y una imagen suelta sigue devolviendo `failed` ("formato no soportado").

Con un `ocr` real:

- **Imagen suelta** (PNG/JPEG, por `mimeType` o firma de archivo): se
  reconoce con el puerto. Texto vacío → `requires_ocr` explícito (nunca
  `extracted` con texto vacío, REQ-166); `not_configured` → `requires_ocr`
  con el detalle del motor; `failed` → `failed`. Con texto real, la página
  incluye `words` (bbox + confianza) y `ocrEngine` queda anotado en el
  resultado -- la procedencia del texto (nativo vs. OCR) nunca se oculta.
- **PDF sin capa de texto**: sigue devolviendo `requires_ocr` (ver "Qué NO
  es este paquete" -- la rasterización de PDF es la pieza pendiente).

## Licencia del modelo de idioma empaquetado

`test/fixtures/lang-data/spa.traineddata` es el modelo oficial de español
del proyecto [`tesseract-ocr/tessdata_fast`](https://github.com/tesseract-ocr/tessdata_fast)
(Apache License 2.0), la misma fuente que `tesseract.js` descarga por
defecto de su CDN pública -- se empaqueta aquí solo para que la suite de
pruebas de este paquete corra determinística y sin depender de red.

## Pruebas

```
npm run -w packages/ocr test           # 17 pruebas, incluye el motor REAL
npm run -w packages/ocr test:coverage  # umbral: líneas/statements ≥80%, ramas ≥70%, funciones ≥80%
npm run -w packages/ocr typecheck
npm run -w packages/ocr lint
```
