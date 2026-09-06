# Matriz de Requisitos Trazable — Atiende Licitaciones

Fuente: PDFs en `PlataformaAgenticaBlueprintseInvestigacionPDF/` (01-Blueprints/BLUEPRINT-LICITACIONES.pdf, 04-Licitaciones-investigacion/L01-L21, 05-Gobierno-y-protocolo/*, DECISIONLLMLICITACIONES.pdf). Extracción con `pdftotext -layout`. Ver `docs/investigacion/pdf-resumen.md` para detalle por documento.

Convención: cuando un requisito legal no cita norma/artículo verificable en el PDF fuente, se marca **VERIFICAR** en la columna de criterio. Ningún dato legal fue completado con conocimiento general no presente en los PDF.

## 1. Descubrimiento de convocatorias

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-001 | Radar debe vigilar ComprasMX (SPA+CSV+JSON), DOF, OCDS SHCP/PDN-S6 y portales estatales cada hora | BLUEPRINT-LICITACIONES.pdf L636-650 | funcional | alta | Ingesta horaria activa; dedupe por número de procedimiento normalizado |
| REQ-002 | Clasificar convocatorias con CUCoP/COG usando LLM | BLUEPRINT-LICITACIONES.pdf L639; L06 §1.2 | funcional | media | precision@5 ≥0.6 sobre gold set 300-500 procedimientos |
| REQ-003 | Detectar señales tempranas: diff de PAAASOP, vencimientos de contratos, desiertas previas, investigaciones de mercado | BLUEPRINT-LICITACIONES.pdf L643-644; L06 §1.6 | funcional | media | Pipeline de "vigía de señales" operando |
| REQ-004 | Registro único de conectores (`Source.fetch(window,cursor)` + `Mapper.to_ocds`), prohibido `if provider === X` fuera del registro | L03 §6.2/§11.2; BLUEPRINT L1010-1011 | técnico | alta | Test estático falla si aparece el patrón prohibido |
| REQ-005 | Raw lake inmutable: cada respuesta cruda con sha256, URL, cabeceras y `fetched_at` | L03 §6.2/§11.1; BLUEPRINT L1010 | técnico | alta | Tabla `SourceSnapshot` con hash, sin reescritura |

## 2. Matching

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-006 | Matching híbrido semántico (pgvector) + léxico (BM25) sobre anexos técnicos, no solo metadatos/título | BLUEPRINT L641-642; L06 §1.1 | funcional | alta | RPC `match_procedures` con RLS (pgTAP); precision@k/nDCG contra gold set |
| REQ-007 | Deduplicación de entidades por RFC (proveedor) y Clave UC (comprador) con tablas de alias | L03 §6.2/§9.2 | técnico | alta | Test de resolución de entidades |
| REQ-008 | Modelo canónico de datos = OCDS 1.1/1.2 + extensión MxCnet; prohibido esquema propio | L03 §0/§11.1; BLUEPRINT L1214-1216 | técnico | alta | Esquema de BD documentado contra OCDS; CI falla si zod≠Pydantic difieren |

## 3. Go/No-Go

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-009 | Arquitectura híbrida: reglas duras deterministas (elegibilidad fiscal, padrón, plazo mínimo, ticket) + modelo estadístico P(ganar)/P(desierta) + LLM solo para explicar | BLUEPRINT L689-694; L06 §2.3 | funcional/técnico | alta | AUC P(ganar) ≥0.70-0.78; AUC P(desierta) ≥0.80 |
| REQ-010 | LLM redacta ≤80 palabras con razones a favor/en contra sin alterar números; solo puede citar cifras de un JSON estructurado previo | BLUEPRINT L696-698; L06 §2.4 | funcional/técnico | alta | Prueba automática rechaza cualquier número ausente del JSON |
| REQ-011 | Umbrales de Go/No-Go configurables por tenant, validados contra últimas 30 convocatorias reales | BLUEPRINT L699-700 | funcional | media | "Con estos criterios habrías visto N" reproducible |
| REQ-012 | Cada sub-score del Go/No-Go debe exponer su evidencia (fila histórica, párrafo de bases, indicador de riesgo) | L06 §2.4 | UX/gobierno | alta | UI de "por qué" auditable |
| REQ-013 | Detección de bases dirigidas: índice de direccionamiento 0-100 combinando señales textuales e históricas (indicadores tipo Cardinal/IMCO) | BLUEPRINT L573-575; L07 §4.1 | funcional | media | Score con explicación por señal |

## 4. Análisis de bases

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-014 | Clasificar páginas nativas vs. escaneadas y extraer texto con layout + bounding box antes de cualquier análisis | BLUEPRINT L565-567 | funcional | alta | ≥98% páginas con texto y bbox sobre gold set |
| REQ-015 | Extraer requisitos atómicos con schema estricto `{id, texto_literal, página, tipo, obligatorio, causa_de_desechamiento, documento_probatorio, criterio, puntos}` | BLUEPRINT L568-570; L07 §0 punto 4 | funcional/técnico | alta | Recall ≥0.85→0.97 según fase; ≥0.99 en causas de desechamiento |
| REQ-016 | Cada cita se verifica por búsqueda difusa del texto literal en la página (ratio ≥0.9) antes de persistir; si falla se marca `cita_no_verificada` y nunca se muestra en verde | BLUEPRINT L571; L07 §2.5 | técnico | alta (tolerancia cero) | 0 alucinaciones en el checklist final |
| REQ-017 | Diff de requisitos entre versiones de convocatoria y actas de junta (no diff de texto plano): sin_cambio/modificado/nuevo/eliminado, con notificación inmediata | BLUEPRINT L575-576/L723-728; L07 §4.3 | funcional | alta | Prueba con 2 versiones reales; republicación gold: 100% cambios detectados |
| REQ-018 | Nunca usar Tesseract como único OCR; pipeline Docling/PyMuPDF (nativo) + Mistral OCR/Azure Layout (escaneos) + visión LLM solo por excepción | L07 §2.3 | técnico | alta | Benchmark interno contra OmniDocBench |
| REQ-019 | XLSX (partidas, catálogos) nunca pasa por el LLM: parseo con pandas/openpyxl a Decimal; el LLM solo mapea encabezados | L07 §2.2 | técnico | alta | Test de no-alucinación numérica |
| REQ-020 | Simulador determinista de puntaje (puntos y porcentajes); valida que la suma de rubros sea 50 o 60 | BLUEPRINT L657-659; L07 §4.4 | funcional/técnico | alta | Test de suma; exactitud ≥0.85 contra gold matrix |
| REQ-021 | Gold set de 100-300 convocatorias anotadas con métricas de gate: precisión de requisitos ≥0.90, precisión de citas 1.00, tasa de alucinación 0 | L07 §5.2 | operación | alta | Suite de evals en pytest/Promptfoo |

## 5. Cumplimiento documental / Bóveda

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-022 | Bóveda documental viva con semáforo de 4 estados: cumple / cumple con documento por vencer / no lo tenemos / no alcanza umbral | BLUEPRINT L572-573/L707-711; L07 §3.4 | funcional | alta | Test de cruce con fechas límite |
| REQ-023 | Semáforo de vigencia documental (32-D SAT, IMSS/INFONAVIT ≤30 días, REPSE 3 años, RUPC) comparado contra fecha del acto, no contra "hoy" | BLUEPRINT L707-711; L02 §13.2 | funcional | alta | Test unitario con fechas límite; alertas 15/7/2 días antes de vencer |
| REQ-024 | Storage con RLS por carpeta de tenant (raw/derived/vault/proposals); rechazo de `.key`/`.cer` por magic bytes | BLUEPRINT L714-716 | seguridad | alta (tolerancia cero) | Subida cruzada entre tenants falla; `.key` rechazado por MIME |
| REQ-025 | Onboarding en ≤15 minutos desde CSF + carpeta de documentos + preguntas guiadas | BLUEPRINT L713-714/L974-980 | UX | media | Activación = primera decisión, no primera vista |
| REQ-026 | KYC negativo obligatorio al alta de tenant: cruce contra 69-B SAT, sancionados y listas oficiales; alerta si listas >48h desactualizadas | BLUEPRINT L57-58 rules; L1472-1483 | legal/seguridad | alta (tolerancia cero) | RFC en lista 69-B definitivo → tenant suspendido |

## 6. Redacción trazable de propuestas

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-027 | Mapear rubro→evidencia de bóveda→puntos; el agente redacta solo lo redactable; todo `Claim` requiere `sources[]` (guardrail `no_unsourced_claims`) | BLUEPRINT L614-616 | funcional/técnico | alta (tolerancia baja) | 0 afirmaciones sin fuente; guardrail dispara en set adversarial |
| REQ-028 | Manifiestos "bajo protesta" solo desde plantillas versionadas (`manifest.json` con base legal, variables tipadas, semver, sha256); hueco sin dato = bloqueo rojo, nunca texto inventado | BLUEPRINT L616-619; rules-licitaciones.pdf §manifiestos | legal/técnico | alta (tolerancia cero) | 0 manifiestos sin `doc_id` de respaldo; cambio de plantilla = gate `legal-doc` → needs-human |
| REQ-029 | Propuesta económica 100% determinista: Decimal en todo el pipeline, redondeo half-up, letra=número, precio nunca lo fija el LLM | BLUEPRINT L671-673/L1429-1432; L08 §3.1 | funcional/técnico | alta (tolerancia cero) | Tests de consistencia numérica con casos borde |
| REQ-030 | Banda legal de precio `[promedio_IM×0.60, mediana_IM×1.10]` calculada por motor determinista; el LLM solo explica la cifra | BLUEPRINT L673/L1425-1426; L02 §6.3 | legal/técnico | alta | Motor determinista, test contra casos reales |
| REQ-031 | Motor propio de "cantidad con letra" (num2words falla en casos borde) | BLUEPRINT L622-623 | técnico | media | 25 casos borde verdes |
| REQ-032 | Huellas de similitud (MinHash) entre tenants sin cruzar contenido; generación condicionada al estilo/evidencia de cada tenant | BLUEPRINT L625-627 (G-11) | legal/anticolusión | alta | Dos tenants con misma plantilla → huella > umbral → regenera y avisa |
| REQ-033 | Un tenant, una propuesta por procedimiento (G-01): `UNIQUE(procedure_id, lot_id) WHERE status='active'`; segundo tenant → modo espectador | BLUEPRINT L493-495/L1258-1262; rules-licitaciones §G-01 | legal/técnico | alta (tolerancia cero) | Constraint DB + fixture con dos tenants |
| REQ-034 | Prohibido compartir plantillas, estilo, precios o contenido entre tenants competidores | BLUEPRINT L495; L08 §0 punto 9 | legal/anticolusión | alta | Revisión de código; detector de similitud inter-tenant |
| REQ-035 | Cada dato renderizado en la propuesta lleva procedencia (`proposal_facts` con fuente, doc_id, página); paquete es snapshot inmutable versionado con SHA-256 | BLUEPRINT L21-23 rules; L08 §6.7 | técnico | alta (tolerancia cero) | Tabla `proposal_facts` poblada; campo sin `sources` = bug |
| REQ-036 | Métrica norte: tasa de correcciones humanas <5% en manifiestos/económica, <15% en técnica al 3er paquete | BLUEPRINT L628-629; L08 §8.3 | operación | media | Dashboard de correcciones por paquete |

## 7. Revisión / Auditoría (Auditor)

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-037 | 5 puertas deterministas antes de cualquier juez LLM: matriz completa, citas a evidencia real, consistencia numérica, formato, coherencia técnica-económica | BLUEPRINT L653-656; L08 §0 punto 7 | funcional/técnico | alta (tolerancia cero) | `AuditReport{blocking[],warnings[]}`; solo `blocking=[]` crea `approval_request` |
| REQ-038 | Simulador del evaluador puntúa la técnica con la rúbrica específica de esa convocatoria | BLUEPRINT L657-659 | funcional | media | Gold matrix: exactitud ≥0.85; 0 falsos "cumple" |
| REQ-039 | Juez LLM debe ser un modelo distinto del Redactor | BLUEPRINT L165-170/L930-932; DECISIONLLM §juez de evals | técnico/gobierno | alta | Verificación en config de modelos |
| REQ-040 | "Sala de guerra" el día de apertura: checklist anti-desechamiento, cuenta regresiva, hash del ZIP, holgura obligatoria de 24h | BLUEPRINT L659-661 | operación | media | Checklist ejecutado antes de cada apertura |
| REQ-041 | Diff de requisitos aplicado también a actas de junta de aclaraciones, con ventana de 24h para preguntas fundadas (cita + numeral + alternativa) | BLUEPRINT L723-728 | funcional/legal | media | Cada pregunta generada con `sources` |

## 8. Entrega y aprobación

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-042 | Máquina de estados del ciclo de vida del paquete (detectada→…→aprobada 1/2→aprobada 2/2→descargada→firmada localmente→enviada→cobranza), cada transición emite evento canónico | BLUEPRINT L910-926 | funcional | alta | Test de transición de estados |
| REQ-043 | HITL vía SDK de agentes: `needs_approval` serializa el estado de ejecución; `approve`/`reject` reanuda una sola vez | BLUEPRINT L927-934; L08 §7.4 | técnico/gobierno | alta | Prueba de pausa/reanudación; doble aprobación no duplica ejecución |
| REQ-044 | Doble confirmación económica: 1/2 técnica-legal (WhatsApp/web, máx. 3 botones), 2/2 económica con re-autenticación (passkey/OTP) por rol distinto; `always_approve` prohibido para precio y envío | BLUEPRINT L484-486/L914-916; L08 §7.2-7.4 | UX/seguridad | alta (tolerancia cero) | Flujo E2E de 2 pasos probado |
| REQ-045 | e.firma nunca en el servidor: firma ocurre en dispositivo del usuario (WebCrypto/agente local); servidor solo recibe documento firmado y hash | BLUEPRINT L490-492/L954-961; L08 §0 punto 6 | legal/seguridad | alta (tolerancia cero) | Grep de patrones DER/PKCS#8 vacío en repo/Storage/logs/traces (CI) |
| REQ-046 | Prohibido envío automático a ComprasMX; la carga siempre la ejecuta una persona | BLUEPRINT L41-43 rules; L02 §13.2 | legal/gobierno | alta (tolerancia cero) | No existe función de envío automatizado; acuse subido a bóveda manualmente |
| REQ-047 | Nunca enviar por WhatsApp: `.key`/`.cer`, contraseñas de e.firma, datos bancarios, el ZIP final (descarga solo desde portal autenticado) | BLUEPRINT L601-604/L7.2; L08 §7.2 | seguridad | alta | Revisión de payloads de mensajes salientes |
| REQ-048 | Contenido mínimo del paquete final: manifiestos, técnica, económica, garantías, checklist con semáforo, resumen ejecutivo, riesgos abiertos, instrucciones de firma, `manifest.json` con SHA-256 | BLUEPRINT L874-903 | funcional | alta | ZIP solo se genera con checklist en verde/ámbar aceptado y ambas aprobaciones |
| REQ-049 | Portal web (back office) con pantallas de bandeja, convocatoria, matriz, visor con citas, económica, versiones/diff, bóveda, calendario, configuración, auditoría | BLUEPRINT L938-944 | funcional/UX | alta | E2E: flujo completo verde; tenant ajeno → 404; sin errores de accesibilidad críticos/serios |

## 9. Seguimiento post-adjudicación

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-050 | Motor de plazos versiona la ley aplicable por fecha de convocatoria (régimen 2000 vs. régimen 2025) | L09 §8 hallazgo 41; BLUEPRINT L499-501 | técnico/legal | alta | Atributo `ley_aplicable` + calendario de días hábiles versionado |
| REQ-051 | Agente de cobranza: máquina de estados del contrato (adjudicado→firmado→garantía→entrega→aceptado→factura→pagado→liberado); dinero en Decimal, intereses/plazos calculados por motor, nunca por LLM | L09 §1.8; BLUEPRINT L736-742 | funcional/técnico | alta | Test de transición de estados; código parsea XML CFDI, no LLM |
| REQ-052 | Extraer del contrato al firmarse: penas, deductivas, fechas de entrega, forma de pago, administrador del contrato, cláusula de cesión de cobro | L09 §8 hallazgo 43; BLUEPRINT L765-771 | funcional/legal | alta | Extracción estructurada validada contra el documento firmado |
| REQ-053 | Redactor de inconformidades con detector de agravios determinista antes del LLM; guardrail anti-frivolidad: viabilidad baja → recomienda no presentar | L09 §2.4; BLUEPRINT L751-759 | funcional/legal | media | Matriz de agravios con viabilidad alta/media/baja; siempre con confirmación humana |
| REQ-054 | Autopsia del fallo: extracción estructurada del acta, clasificación del motivo de pérdida en taxonomía cerrada, acciones derivadas | L09 §3.2 | funcional | media | Pipeline de clasificación con salida accionable |
| REQ-055 | Radar de renovaciones/consolidadas/acuerdos marco: alertar 90/60/30 días antes de vencimientos de contratos | L09 §4.5 | funcional | media | Calendario automatizado de alertas |
| REQ-056 | Motor de calendario legal con días inhábiles y alerta si la convocatoria fija menos plazo del legal mínimo; recordatorios T-72/24/6h | BLUEPRINT L783-789; L06 §4 | funcional | alta | Test de disparo de eventos; infraestructura considerada crítica, no feature |

## 10. Multi-tenant

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-057 | Toda tabla nueva lleva `tenant_id`, RLS habilitada y prueba pgTAP negativa, sin excepción | CLAUDE.pdf L65-66; rules-db.pdf L12-15 | técnico/seguridad | alta (tolerancia cero) | pgTAP negativo obligatorio por tabla |
| REQ-058 | Hechos públicos sin `tenant_id` (RLS de lectura); todo dato del cliente con `tenant_id`+RLS+pgTAP negativo | BLUEPRINT L1217-1218 | técnico/seguridad | alta (tolerancia cero) | pgTAP negativo por tabla de datos privados |
| REQ-059 | "Muralla china" entre tenants competidores: RLS total, vector stores nunca compartidos, prompts sin ejemplos de otro tenant, canary de tenant sintético "competidor" | L10 §9 | seguridad | alta | Eval de aislamiento con canary, 0 tolerancia a fuga |
| REQ-060 | Separación estricta de datos por tenant para producto de lado comprador (OIC/contralorías): nunca exponer información privada de proveedores propios | L09 §5.4/§8 hallazgo 49 | seguridad/gobierno | alta | Test de aislamiento de datos comprador vs. proveedor |
| REQ-061 | Contexto de agente solo incluye datos del tenant en curso y hechos públicos; prohibido few-shot con propuestas de otros tenants; vector stores efímeros por (tenant, procedimiento) | rules-licitaciones.pdf §aislamiento | seguridad/técnico | alta (tolerancia cero) | pgTAP + revisión de configuración de vector store |

## 11. Autenticación / Roles

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-062 | Roles: Director (Go/No-Go, aprobación 2/2, lectura total), Licitador (matriz, técnica 1/2), Legal, Finanzas (económica), Consultor externo (nunca 2/2), Representante legal (firma local) | BLUEPRINT L964-969 | funcional/seguridad | alta | Ningún rol "administrador" puede saltar la doble confirmación ni subir e.firma |
| REQ-063 | Roles vía claims del JWT (`tenant_id`, rol); `tenant_membership{user_id,tenant_id,role,delegations[]}` para licitólogo multi-cliente; cambio de tenant reemite el token | L10 §5.4 | técnico | alta | Test de cambio de tenant sin fuga de datos |
| REQ-064 | Re-autenticación (passkey/OTP) exigida específicamente en la aprobación económica (2/2), distinta del rol que aprueba técnica | BLUEPRINT L914-916; L08 §7.3-7.4 | UX/seguridad | alta | Prueba E2E de re-autenticación |

## 12. Back office

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-065 | Portal Next.js/shadcn con 10 pantallas operativas (ver REQ-049); pruebas Playwright end-to-end | BLUEPRINT L938-944 | funcional/UX | alta | Suite Playwright en verde; axe sin hallazgos critical/serious |
| REQ-066 | Panel de auditoría periódica visible: checklist del blueprint cada 8 tareas cerradas, con veredicto que puede detener el ciclo de desarrollo | CLAUDE.pdf L58-62 | gobierno | alta (tolerancia cero) | Archivo `docs/audits/YYYY-MM-DD-periodic.md` generado; veredicto 🔴 bloquea |
| REQ-067 | ChatGPT App (solo lectura + primera aprobación) nunca exporta documentos firmables ni permite segunda firma | BLUEPRINT L839-843/L945-948 | funcional | media | Widget renderiza solo `toolOutput` de lectura; `callTool` restringido |

## 13. Agentes y herramientas con autorización

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-068 | Toda herramienta con efecto externo lleva `needs_approval=True`; `always_approve` prohibido para fijar precio y emitir paquete | BLUEPRINT L927-934/L0.2004; rules-licitaciones §aprobación | técnico/gobierno | alta (tolerancia cero) | Tabla `approval_request`; prueba pgTAP negativa |
| REQ-069 | Herramientas con `strict:true`/esquemas tipados (zod/Pydantic); el LLM elige entre opciones válidas, nunca calcula precio, tarifa, impuesto ni disponibilidad | rules-agents.pdf §herramientas | técnico | alta (tolerancia cero) | Validación de esquema en CI |
| REQ-070 | Orquestador determinista por código (no LLM-driven) sobre colas: Radar→Analista→Redactor→Auditor→Mensajero | L10 §orquestación; BLUEPRINT L1012-1013 | técnico | alta | Revisión de código; grafo de estados documentado |
| REQ-071 | Transiciones de estado solo por reducer transaccional de base de datos; el agente propone, nunca ejecuta directamente | L10 §4.2 | técnico | alta | Revisión de código |
| REQ-072 | Guardrail de entrada rechaza instrucciones de compartir datos entre tenants, coordinar precios con competidores o contactar servidores públicos fuera de actos formales | rules-licitaciones.pdf §anticolusión; BLUEPRINT L1508-1514 (G-07) | legal/técnico | alta (tolerancia cero) | Suite de ≥200 prompts adversariales: detección ≥99%, falsos positivos ≤2% |

## 14. Idempotencia

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-073 | Idempotencia por `[tenant_id, idempotency_key]` en ejecución de trabajos; UPSERT idempotente en extracción de requisitos | BLUEPRINT L1249-1250; rules-security.pdf §webhooks | técnico | alta | pgTAP: doble INSERT con misma clave → 1 fila |
| REQ-074 | Webhooks de WhatsApp idempotentes por `wamid`; envío de mensajes también idempotente | L10 §4.6; BLUEPRINT L1226-1230 | técnico | alta | Test de doble entrega = no-op |

## 15. Concurrencia

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-075 | Orquestación por código sobre cola con visibilidad por etapa (`q_ingest→q_extract→q_analyze→q_draft→q_audit→q_notify`) | BLUEPRINT L1792-1796 | técnico | alta | Mensaje oculto durante visibility timeout; reaparece si no se archiva |
| REQ-076 | Scraping de fuentes públicas con concurrencia limitada (1-2 conexiones simultáneas por portal) | L03 §8.2 | técnico | alta | Configuración del crawler documentada y probada |

## 16. Reintentos

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-077 | Backoff exponencial ante 429/5xx en scraping; pausa total ante 403 repetidos | L03 §8.2 | técnico | alta | Test de política de reintentos |
| REQ-078 | Cascada de modelos ante 429/5xx (modelo caro→medio→barato) con reintentos configurables; modo de reproducción desde caché para demos | BLUEPRINT L1737-1738 | técnico | media | Plan de contingencia documentado y probado |

## 17. Límites / Rate limits

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-079 | Scraping de portales públicos ≤1 req/s, User-Agent identificable, respeto a robots.txt; nunca CAPTCHA-solving ni áreas autenticadas; nunca raspar agregadores comerciales | rules-licitaciones.pdf §conectores; L03 §8.2 | técnico/legal | alta | Configuración de rate limiter verificada |
| REQ-080 | Límite de 3 botones y listas de 10 opciones en mensajes de WhatsApp (límite de la API) | BLUEPRINT L601-604 | UX/técnico | alta | Test de contrato de contenido de mensajes |
| REQ-081 | Uso de Batch API para cargas nocturnas no urgentes (ahorro de costo); `service_tier` prioritario solo para el Redactor en plazo crítico | DECISIONLLMLICITACIONES.pdf §asignación de modelos | técnico | media | Configuración de colas por prioridad |

## 18. Trazabilidad / Auditoría

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-082 | Todo dato extraído es un objeto `Claim{text, sources[{doc_id,page,quote}]}`; campo sin `sources` es considerado un bug | rules-licitaciones.pdf §trazabilidad; BLUEPRINT L21-23 | técnico | alta (tolerancia cero) | `cita_no_verificada` nunca se muestra en verde al usuario |
| REQ-083 | Bitácora de auditoría append-only con hash encadenado (`audit_log`/`proposal_audit_log`); sin UPDATE/DELETE por política y trigger | BLUEPRINT L496-498 (G-06); L08 §7.7 | técnico/legal | alta (tolerancia cero) | pgTAP: UPDATE falla; verificación de cadena de hashes en CI |
| REQ-084 | Registro de quién vio qué texto exacto, quién aprobó y qué documento sustentó cada afirmación | BLUEPRINT L496-498 | técnico/legal | alta | Consulta de auditoría reconstruye la decisión completa |
| REQ-085 | Guardrail de salida rechaza cualquier afirmación sin fuente verificable (`no_unsourced_claims`) antes de persistir | BLUEPRINT L614-616 | técnico | alta (tolerancia cero) | 0 afirmaciones sin fuente en el artefacto final |

## 19. Observabilidad

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-086 | Trazas del runtime de agentes con `trace_include_sensitive_data=False` en producción; espejo en herramienta de tracing propia (self-host) si el proveedor no ofrece retención cero | BLUEPRINT L1124-1127 | técnico | alta | Test de redacción de PII en trazas |
| REQ-087 | Evals automatizados (pytest + graders deterministas + juez LLM calibrado) que bloquean el merge si bajan de umbral | BLUEPRINT L1133-1137/L1904-1907 | técnico | alta | Pipeline de CI con reporte de evals en verde antes de mergear |
| REQ-088 | SLOs definidos y monitoreados: análisis de convocatoria <20min p95, paquete completo <8h laborales, notificación WhatsApp <60s p95, disponibilidad portal ≥99.5% | BLUEPRINT L1203-1206; L10 §8.4 | operación | media | Medición en monitoreo/CI contra los SLO declarados |

## 20. Accesibilidad

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-089 | Portal web sin hallazgos de accesibilidad critical/serious (mencionado solo tangencialmente en pruebas E2E del portal) | BLUEPRINT L938-944 (mención en criterio de pruebas) | UX | media | Auditoría automatizada (axe) sin hallazgos critical/serious — **VERIFICAR**: ningún PDF define estándar WCAG explícito ni requisitos de accesibilidad de producto más allá de esta mención en pruebas |

## 21. Móvil / Canales

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-090 | WhatsApp como interfaz de trabajo primaria (no solo alertas): decide vía botones/listas/PDF; nunca edita matriz o propuesta desde el chat | rules-licitaciones.pdf §whatsapp; L04 §8.2 hallazgo 11 | UX | alta | Flujo completo operable desde WhatsApp para lo permitido; edición bloqueada |
| REQ-091 | Horario de envío de WhatsApp 7:00-22:00 salvo plazo <24h; opt-in por persona y rol | BLUEPRINT L601-604 | UX/legal | media | Test de contrato de horario de envío |
| REQ-092 | Voz (Realtime): solo consultas y recordatorios; "confirmo" verbal registra intención pero nunca ejecuta ni sustituye la firma/aprobación | BLUEPRINT L949-953/L1225-1226 | funcional/seguridad | alta | Guardrail: la palabra "confirmo" nunca ejecuta la herramienta de fijar precio |
| REQ-093 | Disclosure de IA obligatorio en los primeros segundos de voz y en el primer mensaje de WhatsApp; respuesta fija ante "¿eres humano?"; transferencia a humano en <10s | rules-agents.pdf §disclosure | UX/legal | alta | Test de contrato de disclosure |
| REQ-094 | No se identificó ningún requisito de app móvil nativa en los PDF; el "móvil" del producto es exclusivamente WhatsApp + web responsive | (ausencia confirmada en L04, L06, L08, L09, BLUEPRINT) | UX | — | **VERIFICAR** con el equipo de producto si se requiere app nativa; no está especificado |

## 22. Seguridad

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-095 | Nunca PAN, CVV, e.firma, tokens de API ni contraseñas en código, fixtures, logs, prompts o commits; secretos por variables de entorno / Vault-KMS en producción | CLAUDE.pdf L71-73; rules-security.pdf §secretos | seguridad | alta (tolerancia cero) | Escaneo de secretos (ej. gitleaks) limpio en CI |
| REQ-096 | Verificación HMAC y deduplicación por `event_id` en todos los webhooks entrantes | rules-security.pdf §webhooks | técnico/seguridad | alta | Tests de firma y deduplicación |
| REQ-097 | Red-teaming de inyección de prompt (documentos de bases/actas no confiables, mensajes de WhatsApp) integrado en CI | rules-security.pdf §red-teaming; L10 §2.4 | seguridad | alta | Suite adversarial en CI con PDF/mensajes maliciosos |
| REQ-098 | Prohibido leer, subir, persistir o transmitir `.cer/.key/.pfx/.p12` o contraseñas de e.firma; UI rechaza por extensión y magic bytes | rules-licitaciones.pdf §e.firma | seguridad/legal | alta (tolerancia cero) | Grep de patrones DER/PKCS#8 vacío en CI sobre repo/Storage/logs |
| REQ-099 | Minimización de datos personales de proveedores y servidores públicos (RFC/CURP); sin perfilado; intervención humana antes de cualquier efecto de un score sobre una persona | BLUEPRINT L82-85 rules; L03 §8.4 | legal | alta | Revisión de almacenamiento cifrado y de flujo de decisión |

## 23. Marco legal de contratación pública (México)

**Jurisdicción**: México — régimen federal y 32 configuraciones estatales/municipales paramétricas. Advertencia de los propios documentos fuente: existen **fechas contradictorias entre archivos** sobre la publicación/vigencia de la nueva LAASSP (16-abr-2025 según L02 vs. 16-jul-2025 según L07/L08/L09) y sobre el plazo de pago (17 días hábiles vs. 20 naturales, señalado como pendiente de verificación jurídica en `DECISIONS-HUMANAS.pdf` y `tasks-licitaciones-FOCUS.pdf`). Ninguna sesión de investigación pudo abrir el DOF/diputados.gob.mx directamente; la mayoría de las citas de artículo provienen de una copia de terceros en GitHub (`bajalabs/Mexican_Laws`), no del DOF oficial.

| ID | Requisito | Norma citada en el PDF | Fuente | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-100 | Motor determinista de plazos legales del procedimiento (nunca decidido por el LLM), versionado por fecha de convocatoria | Régimen LAASSP 2000 vs. régimen nuevo (fecha en disputa entre archivos) | L02 §0 punto 10/§13.2; BLUEPRINT L499-501/L1411-1417 | alta | Motor de calendario con `norma_version`/`articulo_map`; **VERIFICAR fecha exacta de vigencia antes de codificar** |
| REQ-101 | Catálogo de requisitos con carácter de causa de desechamiento (sí/no) por convocatoria | Sin artículo único citado; práctica derivada de bases tipo | L02 §13.1 hallazgo 30 | alta | Matriz de cumplimiento con campo `causa_desechamiento` booleano |
| REQ-102 | Umbral de "precio no aceptable" (>10% sobre mediana de investigación de mercado) y umbral de oferta subvaluada | "Art. 2 fr. XI LAASSP (nueva)" — citado vía fuente secundaria (repo GitHub), no vía DOF | L09 §1.7/§2.3 | alta | **VERIFICAR contra el DOF** antes de fijar el umbral en el motor determinista |
| REQ-103 | El fallo debe listar desechados con razones; contra el fallo no cabe "recurso", solo inconformidad | "Art. 49 LAASSP (nueva)" — misma salvedad de fuente secundaria | L09 §1.1/§2.1; BLUEPRINT L751-759 | alta | **VERIFICAR** cita contra el DOF; lectura del acta el mismo día de publicación |
| REQ-104 | Plazo de inconformidad ante la autoridad: "6 días hábiles (10 bajo tratados)" | Numeración de artículo en disputa entre L02 (marca ⚖️ pendiente) y L09 (lo trata como dato) | L02 §13.2; L09 §1-2 | alta | **VERIFICAR** — el propio L02 marca este plazo como no confirmado |
| REQ-105 | Plazo de pago tras verificación de factura | "17 días hábiles" (L09, vía fuente secundaria) vs. "20 días naturales" (art. 51, régimen 2000, citado en L02/L05) | L02 §2.2/§4.1; L05 §2.6; L09 §0.1/§1.7 | alta | **VERIFICAR** — contradicción explícita entre archivos, declarada pendiente de verificación jurídica en `DECISIONS-HUMANAS.pdf` |
| REQ-106 | Garantía de cumplimiento 10-20% del monto del contrato, sin IVA | Sin número de artículo específico verificado en el PDF | BLUEPRINT L1420-1427 | media | **VERIFICAR** artículo exacto antes de codificar el porcentaje |
| REQ-107 | Topes de convenios modificatorios: 20% (bienes/servicios); 25% (obra, sin verificar en ningún archivo) | Art. citado solo para el 20%; el 25% de obra está marcado explícitamente [E] (estimación, no verificado) | BLUEPRINT L1427-1428 | media | **VERIFICAR** el tope de obra (25%) antes de usarlo en cualquier cálculo |
| REQ-108 | Puntos y porcentajes: técnica hasta 50/60 puntos, económica 40/50, mínimo técnico 37.5/45 | Lineamientos SFP de 9-sep-2010 (reforma 2023 sin verificar) | L02 §6.1; L07 §4.4; L08 §2.3 | alta | Simulador determinista de puntaje contra la rúbrica específica de cada convocatoria |
| REQ-109 | Manifiesto de estratificación MIPyME (personal + ventas anuales) | Acuerdo de estratificación SE, 30-jun-2009 | L02 §6.4 | media | Plantilla versionada de manifiesto con campos obligatorios |
| REQ-110 | Montos máximos de adjudicación directa e invitación restringida por tramo de presupuesto anual | PEF (anexo de montos), año fiscal vigente — el propio documento marca el tramo citado como "no confirmado, posiblemente intermedio" | L02 §1.2/§3.3; BLUEPRINT L1420 | alta | **VERIFICAR** contra el PEF del ejercicio fiscal vigente antes de fijar el umbral |

## 24. Legal — anticorrupción / ética / guardrails

| ID | Requisito | Norma citada en el PDF | Fuente | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-111 | Fingerprint de entidad (RFC, socios, representantes, domicilio) para detectar interpósita persona entre tenants | "LGRA 67, LAASSP 90-V" (citado en el documento; no verificado contra DOF por el equipo) | BLUEPRINT L1465-1471 (G-02) | alta | Matching de huellas de entidad entre tenants con reporte a compliance |
| REQ-112 | Cruce nocturno con lista 69-B, sancionados y listas oficiales de inhabilitados antes y durante la relación con el tenant | "LAASSP 71-V" (citado; no verificado contra DOF) | BLUEPRINT L1472-1483 (G-03) | alta (tolerancia cero) | Job nocturno de KYC negativo con alerta si hay coincidencia |
| REQ-113 | Manifiesto falso: plantilla versionada + evidencia + confirmación humana registrada + cuestionario de vínculos/colusión con OTP | "CPF 247, LAASSP 40/89-90" (citado; no verificado contra DOF) | BLUEPRINT L1490-1497 (G-05) | alta (tolerancia cero) | Ningún manifiesto se emite sin evidencia y confirmación registrada |
| REQ-114 | Tripwires deterministas + verificación LLM contra instrucciones ilícitas (soborno, coordinación de precios) | rules-licitaciones.pdf §anticolusión (sin artículo único citado, política interna del producto) | BLUEPRINT L1508-1514 (G-07) | alta | 200 prompts adversariales: detección ≥99%, falsos positivos ≤2% |
| REQ-115 | Disclosure de uso de IA obligatorio en WhatsApp, portal, PDF y escritos dirigidos a la autoridad, desde un motor único de disclosure | "AI Act art. 50, políticas de uso del proveedor de LLM, LFPDPPP" (citado; AI Act es normativa de la UE, aplicabilidad a México **VERIFICAR**) | BLUEPRINT L1521-1526 (G-09) | alta | Leyenda de disclosure presente en todo artefacto generado por IA |
| REQ-116 | Banderas de riesgo (bases dirigidas, indicadores de irregularidad) se reportan siempre como "riesgo estadístico", nunca como acusación; agregación mínima antes de mostrar cualquier señal | rules-licitaciones.pdf §ética (política interna, no cita norma) | BLUEPRINT L1567-1569 | alta | Texto de UI revisado por abogado antes de publicarse (decisión humana reservada) |
| REQ-117 | Responsabilidad exclusiva del licitante sobre la veracidad de lo manifestado ante el Estado | "LAASSP 45" (citado; no verificado contra DOF) | BLUEPRINT L2309-2311 | alta | Aviso legal explícito en la UI antes de cada envío de manifiesto |
| REQ-118 | Sin ley de IA vigente en México a la fecha del documento; marco práctico aplicado = políticas de uso del proveedor de LLM + NIST AI RMF + AI Act art. 50 si el producto se exporta a la UE | Explícitamente declarado como ausencia normativa por el propio documento | BLUEPRINT L2325-2330 | alta | Diseñar el producto asumiendo clasificación de "alto riesgo" — **VERIFICAR** si cambia el marco regulatorio mexicano antes de cada release |

## 25. Legal — datos personales, propiedad intelectual y corporativo

| ID | Requisito | Norma citada en el PDF | Fuente | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-119 | Contrato de encargo, aviso de privacidad integral y simplificado, plazo de respuesta a derechos ARCO, minimización de RFC/CURP | "LFPDPPP: multas hasta 320,000 UMA" (citado; fecha de la ley/reforma no verificada en el PDF) | BLUEPRINT L1544-1554 (G-12) | alta | Aviso de privacidad publicado y vigente; RLS por tenant sobre datos personales |
| REQ-120 | Redacción de PII antes de enviar contenido a proveedores de LLM externos; intervención humana obligatoria antes de que un score tenga efecto sobre una persona | Derivado de LFPDPPP, sin artículo específico adicional al citado en REQ-119 | BLUEPRINT L1544-1554 | alta | Test de redacción de PII en el pipeline antes de la llamada al LLM |
| REQ-121 | Autoría de la obra (propuesta) recae en persona física; el software puede protegerse por derechos de autor pero no el texto generado por IA per se | "LFDA art. 12" (citado; reforma referida sin verificar fecha exacta contra el DOF) | BLUEPRINT L2320-2323 | media | **VERIFICAR** antes de cualquier declaración de autoría en contratos con clientes |
| REQ-122 | Scraping limitado a zona pública y datos abiertos; reutilización de datos gubernamentales amparada en transparencia | "LGTAIP" y "CPF 211 bis" (citados; alcance exacto **VERIFICAR**) | BLUEPRINT L2285-2287 | alta | Revisión legal de cada nueva fuente antes de activarla en el registro de conectores |
| REQ-123 | Constitución como S.A.P.I. antes de cobrar a clientes en piloto pagado (S.A.S. tiene tope legal de ingresos) | Tope de ingresos de S.A.S. citado sin número de artículo verificado | BLUEPRINT L2334-2336 | media | Decisión reservada al fundador; **VERIFICAR** el tope vigente antes de definir forma jurídica |

## 26. Decisiones de arquitectura / LLM (DECISIONLLMLICITACIONES.pdf)

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-124 | Runtime de agentes = OpenAI Agents SDK + Responses API con 3 niveles de modelo (barato: triage/clasificación/mensajería; medio: extracción/auditoría; caro: redacción técnica/detección de bases dirigidas) | DECISIONLLMLICITACIONES.pdf §3/§8 | técnico | alta (fija en fase hackathon) | Configuración de modelos por rol documentada en el repo |
| REQ-125 | 5 componentes de "tolerancia cero" (recall del Analista, juez del Auditor, redactor de escritos legales/Abogado, verificador de entailment de Claims, clasificador anticolusión) permanecen siempre en modelos de proveedores con sede en EE.UU., en todas las fases evaluadas | DECISIONLLMLICITACIONES.pdf §2/§12 | técnico/gobierno | alta (tolerancia cero) | Configuración de enrutamiento de modelos auditable; ningún componente de esta lista enruta a otro proveedor sin pasar los 5 gates |
| REQ-126 | 5 gates obligatorios antes de enrutar cualquier componente de volumen a un proveedor/modelo alternativo: calidad (recall no debajo de frontera -1pp), cumplimiento estricto de esquema (0 fallos en 10,000 salidas), residencia/retención de datos declarada, suite de alineación (≥200 prompts, rechazo ≤1%), y operación (rutas de respaldo + presupuesto máximo por corrida) | DECISIONLLMLICITACIONES.pdf §12.2 | técnico/legal | alta (tolerancia cero) | Evidencia de los 5 gates documentada en `tasks/evidence/` antes de cualquier cambio de enrutamiento |
| REQ-127 | Verificador de entailment de cada `Claim` y juez de evals: modelo distinto del que generó el contenido, calibrado contra anotadores humanos | DECISIONLLMLICITACIONES.pdf §verificador/juez de evals | técnico/gobierno | alta (tolerancia cero) | Guardrail de salida obligatorio; calibración periódica documentada |
| REQ-128 | Uso de Batch API para trabajo no urgente (ahorro de costo); prompt caching activo por defecto; presupuesto máximo (budget cap) por corrida con alerta si se excede | DECISIONLLMLICITACIONES.pdf §asignación de modelos; BLUEPRINT L2021-2022 | técnico/operación | media | Configuración de `budget_cap` por corrida verificada en producción |
| REQ-129 | OCR/parseo de documentos: motor local (Docling/PyMuPDF) para páginas nativas por defecto; servicio de OCR especializado solo para páginas escaneadas, por excepción | DECISIONLLMLICITACIONES.pdf §OCR | técnico | alta | ≥70% de páginas procesadas con motor local a costo marginal cero |
| REQ-130 | Decisión reservada al fundador: alcance del proyecto/organización de la cuenta del proveedor de LLM (compartido vs. por tenant), nivel de retención de datos contratado, y región de procesamiento | DECISIONLLMLICITACIONES.pdf §decisión humana reservada | gobierno | alta | Marcado `needs-human`; no se resuelve por el equipo de ingeniería sin aprobación |
| REQ-131 | Toda tarea que implemente el enrutamiento a un proveedor/modelo distinto del principal debe declararse en el aviso de privacidad y en un reporte de transparencia del producto | DECISIONLLMLICITACIONES.pdf §decisión humana reservada (nueva) | gobierno/legal | alta | Aviso de privacidad y reporte de transparencia actualizados antes del cambio |

## 27. Fuentes de datos de convocatorias

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-132 | Conector a ComprasMX (sitio público + backend interno + CSV de datos abiertos) como fuente primaria federal mexicana | L03 §fuentes; BLUEPRINT §13 tabla de fuentes | técnico | alta | Conector con pruebas de contrato diarias contra el sitio real |
| REQ-133 | Conector a la API OCDS de datos abiertos de la SHCP (`api.datos.gob.mx`) y al Sistema 6 de la Plataforma Digital Nacional | L03 §fuentes | técnico | alta | Conector documentado con esquema OCDS validado |
| REQ-134 | Conector al Diario Oficial de la Federación como fuente de verificación cruzada de convocatorias y plazos legales | L03 §fuentes; BLUEPRINT §13 | técnico | media | Job de verificación cruzada operando |
| REQ-135 | Conectores a portales estatales con API OCDS propia (patrón compartido `/edca/...`: CDMX, Nuevo León, Yucatán, entre otros) | L03 §fuentes; BLUEPRINT §13 | técnico | media | Un conector genérico cubre los portales con el mismo patrón de API |
| REQ-136 | PLACSP (España) y TED/eForms (Unión Europea) se mencionan únicamente como referentes de diseño para una eventual expansión a la UE; ningún PDF documenta un conector activo a PLACSP/TED en el alcance actual del producto mexicano | L03 §7; BLUEPRINT §13 (expansión) | técnico/legal | baja | **VERIFICAR** con el equipo si se requiere el conector antes de comprometerlo en el roadmap; no está especificado como requisito actual |

## 28. Gobierno / Proceso de construcción

| ID | Requisito | Fuente | Tipo | Prioridad | Criterio verificable |
|---|---|---|---|---|---|
| REQ-137 | Loop de trabajo obligatorio: tomar tarea sin dependencias → estudiar spec y sección del blueprint citada → si falta criterio verificable, pasar a `blocked` (nunca improvisar) → TDD → tocar solo el alcance de esa tarea | CLAUDE.pdf L40-51 | gobierno/proceso | alta | Evidencias por tarea en `tasks/evidence/<id>/` |
| REQ-138 | Todo cambio en prompt, esquema o modelo dispara la suite de evals de gate antes de mergear | rules-licitaciones.pdf §evals gate; BLUEPRINT L1904-1907 | técnico/gobierno | alta | CI en verde obligatorio antes de merge |
| REQ-139 | Decisiones reservadas explícitamente al fundador (pricing final, forma jurídica, exclusividad por tenant, cooperación con autoridades, mezcla de proveedores de LLM, entre otras) nunca se cierran dentro del ciclo autónomo de desarrollo | DECISIONS-HUMANAS.pdf; rules-licitaciones.pdf | gobierno | alta | Toda tarea que las toque se marca `needs-human` obligatoriamente |
| REQ-140 | Bloqueos conocidos declarados por el propio equipo deben resolverse antes de codificar los módulos dependientes: verificación jurídica de plazos, HAR de ComprasMX, aprobación de plantillas de WhatsApp ante el proveedor | tasks-licitaciones-FOCUS.pdf | gobierno | alta | Ninguno de estos bloqueos estaba resuelto al cierre de los documentos fuente — **VERIFICAR estado actual antes de iniciar el módulo dependiente** |

---

**Total de requisitos**: 140 (REQ-001 a REQ-140), organizados en 28 módulos. Ver `docs/ACEPTACION.md` para los criterios de aceptación derivados y `docs/investigacion/pdf-resumen.md` para el detalle por documento fuente.
