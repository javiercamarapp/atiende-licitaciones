# Criterios de Aceptación — Atiende Licitaciones

Un criterio de aceptación por requisito (o grupo de requisitos estrechamente relacionados) de `docs/REQUISITOS.md`. Estado inicial de todos: **PENDIENTE**. Tipo de prueba: unit / integración / E2E / adversarial / render.

| REQ | Criterio de aceptación | Prueba | Estado |
|---|---|---|---|
| REQ-001 | El Radar ingiere ComprasMX/DOF/OCDS/portales estatales cada hora y deduplica por número de procedimiento normalizado | integración | PENDIENTE |
| REQ-002 | Clasificador CUCoP alcanza precision@5 ≥0.6 sobre gold set de 300-500 procedimientos | unit | PENDIENTE |
| REQ-003 | Pipeline de señales tempranas detecta diffs de PAAASOP, vencimientos y desiertas en un set de prueba | integración | PENDIENTE |
| REQ-004 | Test estático falla si aparece un `if provider === X` fuera del registro de conectores | unit | PENDIENTE |
| REQ-005 | Cada `SourceSnapshot` persiste sha256/URL/cabeceras/`fetched_at` y nunca se reescribe | integración | PENDIENTE |
| REQ-006 | `match_procedures` devuelve resultados con RLS activa (pgTAP) y precision@k/nDCG medibles contra gold set | integración | PENDIENTE |
| REQ-007 | Resolución de entidades por RFC/Clave UC con alias pasa el set de prueba de deduplicación | unit | PENDIENTE |
| REQ-008 | El esquema de BD valida contra OCDS 1.1/1.2+MxCnet; CI falla si los esquemas zod/Pydantic divergen | unit | PENDIENTE |
| REQ-009 | AUC de P(ganar) ≥0.70-0.78 y de P(desierta) ≥0.80 sobre gold set histórico | unit | PENDIENTE |
| REQ-010 | Prueba automática rechaza cualquier cifra en el texto del LLM ausente del JSON de entrada | adversarial | PENDIENTE |
| REQ-011 | Recalcular Go/No-Go con umbrales configurados reproduce "habrías visto N" sobre las últimas 30 convocatorias | integración | PENDIENTE |
| REQ-012 | Cada sub-score del Go/No-Go es auditable hasta su evidencia origen en la UI | E2E | PENDIENTE |
| REQ-013 | El índice de direccionamiento (0-100) se calcula con desglose por señal explicable | unit | PENDIENTE |
| REQ-014 | ≥98% de páginas del gold set quedan con texto y bbox extraídos correctamente | integración | PENDIENTE |
| REQ-015 | Recall de requisitos atómicos ≥0.85(H)/0.93(M)/0.97(G); ≥0.99 en causas de desechamiento | integración | PENDIENTE |
| REQ-016 | 0 citas alucinadas llegan en verde al checklist final sobre el gold set de verificación | adversarial | PENDIENTE |
| REQ-017 | Diff entre dos versiones reales de convocatoria detecta el 100% de cambios del gold set | integración | PENDIENTE |
| REQ-018 | Benchmark interno de OCR (Docling/PyMuPDF + Mistral/Azure) supera el umbral definido sin depender solo de Tesseract | unit | PENDIENTE |
| REQ-019 | Parseo de XLSX vía pandas/openpyxl no introduce alucinación numérica en el set de prueba | unit | PENDIENTE |
| REQ-020 | El simulador de puntaje determinista valida que la suma de rubros sea 50 o 60 en 100% de los casos de prueba | unit | PENDIENTE |
| REQ-021 | Suite de evals (pytest/Promptfoo) reporta precisión de requisitos ≥0.90, citas 1.00 y alucinación 0 sobre gold set de 100-300 convocatorias | integración | PENDIENTE |
| REQ-022 | El semáforo de 4 estados de la bóveda documental clasifica correctamente casos de prueba con fechas límite variadas | unit | PENDIENTE |
| REQ-023 | Alertas de vencimiento (15/7/2 días) se disparan comparando contra la fecha del acto, no contra "hoy" | unit | PENDIENTE |
| REQ-024 | Subida cruzada entre tenants falla por RLS; `.key`/`.cer` rechazados por magic bytes | adversarial | PENDIENTE |
| REQ-025 | Onboarding completo en ≤15 minutos medido en prueba de usuario/E2E | E2E | PENDIENTE |
| REQ-026 | Un RFC presente en la lista 69-B definitiva suspende automáticamente el alta del tenant | integración | PENDIENTE |
| REQ-027 | 0 afirmaciones sin `sources[]` pasan el guardrail `no_unsourced_claims` en el set adversarial | adversarial | PENDIENTE |
| REQ-028 | Ningún manifiesto se emite sin `doc_id` de respaldo; hueco de dato bloquea en rojo | unit | PENDIENTE |
| REQ-029 | Casos borde de la propuesta económica (redondeo, letra=número) pasan en Decimal sin excepción | unit | PENDIENTE |
| REQ-030 | La banda de precio `[prom×0.60, mediana×1.10]` se calcula igual en 100% de casos reales de prueba | unit | PENDIENTE |
| REQ-031 | 25 casos borde de "cantidad con letra" (incl. "veintiuno") pasan en verde | unit | PENDIENTE |
| REQ-032 | Dos tenants con plantilla idéntica generan huella MinHash sobre el umbral y disparan regeneración | adversarial | PENDIENTE |
| REQ-033 | Constraint `UNIQUE(procedure_id, lot_id) WHERE status='active'` rechaza el segundo tenant activo en el mismo procedimiento | integración | PENDIENTE |
| REQ-034 | Revisión de código confirma que ninguna plantilla/precio se comparte entre tenants competidores | unit | PENDIENTE |
| REQ-035 | La tabla `proposal_facts` está poblada para el 100% de datos renderizados en un paquete de prueba | integración | PENDIENTE |
| REQ-036 | Dashboard mide tasa de correcciones humanas por paquete contra los umbrales (<5%/<15%) | integración | PENDIENTE |
| REQ-037 | `AuditReport{blocking[]}` vacío es condición necesaria para crear `approval_request`, verificado en casos de prueba con y sin bloqueos | integración | PENDIENTE |
| REQ-038 | Exactitud del simulador de evaluador ≥0.85 y 0 falsos "cumple" sobre gold matrix | unit | PENDIENTE |
| REQ-039 | Configuración confirma que el modelo juez es distinto del modelo redactor | unit | PENDIENTE |
| REQ-040 | Checklist de "sala de guerra" se ejecuta completo antes de cada apertura simulada | E2E | PENDIENTE |
| REQ-041 | Preguntas de junta generadas incluyen `sources` verificables en el 100% de casos de prueba | unit | PENDIENTE |
| REQ-042 | Cada transición de la máquina de estados del paquete emite un evento canónico verificable | integración | PENDIENTE |
| REQ-043 | Pausa y reanudación de `needs_approval` no ejecuta la acción dos veces ante doble aprobación | integración | PENDIENTE |
| REQ-044 | Flujo E2E de doble confirmación (1/2 + 2/2 con re-autenticación) completa correctamente y rechaza `always_approve` en precio | E2E | PENDIENTE |
| REQ-045 | CI: grep de patrones DER/PKCS#8 vacío en repo/Storage/logs/traces | unit | PENDIENTE |
| REQ-046 | No existe función/endpoint de envío automático a ComprasMX en el código | unit | PENDIENTE |
| REQ-047 | Revisión de payloads de WhatsApp confirma ausencia de `.key`/`.cer`/contraseñas/datos bancarios/ZIP final | adversarial | PENDIENTE |
| REQ-048 | El ZIP final solo se genera con checklist en verde/ámbar aceptado y ambas aprobaciones registradas | integración | PENDIENTE |
| REQ-049 | Suite Playwright cubre las 10 pantallas del portal; acceso cruzado de tenant devuelve 404; axe sin critical/serious | E2E | PENDIENTE |
| REQ-050 | El motor de plazos aplica la ley correcta según la fecha de la convocatoria en casos de prueba de ambos regímenes | unit | PENDIENTE |
| REQ-051 | Máquina de estados del contrato transiciona correctamente en el set de prueba; cifras de dinero en Decimal | integración | PENDIENTE |
| REQ-052 | Extracción estructurada del contrato firmado valida contra un documento de prueba anotado | unit | PENDIENTE |
| REQ-053 | Matriz de agravios clasifica viabilidad y bloquea "no presentar" en casos de baja viabilidad | unit | PENDIENTE |
| REQ-054 | Clasificación del motivo de pérdida produce una acción derivada accionable en el set de prueba | unit | PENDIENTE |
| REQ-055 | Alertas de renovación se disparan en 90/60/30 días antes del vencimiento simulado | integración | PENDIENTE |
| REQ-056 | El motor de calendario legal alerta cuando la convocatoria fija menos plazo del mínimo legal | unit | PENDIENTE |
| REQ-057 | pgTAP negativo confirma RLS en el 100% de tablas nuevas | unit | PENDIENTE |
| REQ-058 | pgTAP negativo distingue correctamente tablas públicas (sin tenant_id) de privadas (con RLS) | unit | PENDIENTE |
| REQ-059 | Eval de aislamiento con tenant sintético "competidor" no produce fuga de datos | adversarial | PENDIENTE |
| REQ-060 | Test de aislamiento confirma que el producto de lado comprador no expone datos de proveedores propios | integración | PENDIENTE |
| REQ-061 | pgTAP y revisión de configuración de vector store confirman ausencia de datos de otros tenants en el contexto del agente | integración | PENDIENTE |
| REQ-062 | Ningún rol "administrador" puede saltar la doble confirmación ni subir e.firma en pruebas de autorización | adversarial | PENDIENTE |
| REQ-063 | Cambiar de tenant reemite el JWT y no permite acceso a datos del tenant anterior | integración | PENDIENTE |
| REQ-064 | La aprobación económica exige passkey/OTP en un flujo E2E de prueba | E2E | PENDIENTE |
| REQ-065 | Suite Playwright completa en verde; axe sin hallazgos critical/serious | E2E | PENDIENTE |
| REQ-066 | El archivo de auditoría periódica se genera cada 8 tareas cerradas y un veredicto 🔴 detiene el pipeline de CI/CD | integración | PENDIENTE |
| REQ-067 | El widget de ChatGPT App solo permite `callTool` de lectura; no expone documentos firmables | adversarial | PENDIENTE |
| REQ-068 | pgTAP negativo confirma que ninguna herramienta con efecto externo carece de `needs_approval` | unit | PENDIENTE |
| REQ-069 | Validación de esquema (zod/Pydantic strict) rechaza llamadas de herramienta que intenten fijar precio/tarifa | unit | PENDIENTE |
| REQ-070 | Revisión de código confirma que el grafo de orquestación está definido por código, no por decisión del LLM | unit | PENDIENTE |
| REQ-071 | Revisión de código confirma que las transiciones de estado pasan por el reducer transaccional, nunca ejecución directa del agente | unit | PENDIENTE |
| REQ-072 | Suite de ≥200 prompts adversariales anticolusión: detección ≥99%, falsos positivos ≤2% | adversarial | PENDIENTE |
| REQ-073 | pgTAP: doble INSERT con la misma `idempotency_key` produce una sola fila | unit | PENDIENTE |
| REQ-074 | Doble entrega del mismo `wamid` es tratada como no-op | integración | PENDIENTE |
| REQ-075 | Mensaje en cola permanece oculto durante el visibility timeout y reaparece si no se archiva | integración | PENDIENTE |
| REQ-076 | Configuración del crawler limita la concurrencia a 1-2 conexiones por portal en prueba de carga | unit | PENDIENTE |
| REQ-077 | Política de reintentos aplica backoff exponencial ante 429/5xx y pausa total ante 403 repetidos | integración | PENDIENTE |
| REQ-078 | Cascada de modelos (caro→medio→barato) se activa correctamente ante fallos simulados 429/5xx | integración | PENDIENTE |
| REQ-079 | Configuración del rate limiter respeta ≤1 req/s y robots.txt en prueba contra fixture de portal | unit | PENDIENTE |
| REQ-080 | Mensajes de WhatsApp de prueba nunca exceden 3 botones ni 10 elementos de lista | unit | PENDIENTE |
| REQ-081 | Cargas nocturnas usan Batch API; tareas críticas usan `service_tier` prioritario, verificado en configuración | unit | PENDIENTE |
| REQ-082 | `cita_no_verificada` nunca se renderiza como verde en la UI de prueba | adversarial | PENDIENTE |
| REQ-083 | pgTAP: intento de UPDATE/DELETE sobre `audit_log` falla; verificación de cadena de hashes pasa en CI | unit | PENDIENTE |
| REQ-084 | Consulta de auditoría reconstruye completamente quién vio/aprobó/sustentó una decisión de prueba | integración | PENDIENTE |
| REQ-085 | 0 afirmaciones sin fuente pasan el guardrail de salida en el artefacto final de prueba | adversarial | PENDIENTE |
| REQ-086 | Test de redacción de PII confirma que las trazas no contienen datos sensibles | unit | PENDIENTE |
| REQ-087 | El pipeline de CI bloquea el merge si los evals bajan del umbral configurado | integración | PENDIENTE |
| REQ-088 | Monitoreo confirma cumplimiento de los SLO declarados (análisis <20min p95, paquete <8h, WhatsApp <60s, disponibilidad ≥99.5%) | integración | PENDIENTE |
| REQ-089 | Auditoría automatizada (axe u homóloga) del portal no reporta hallazgos critical/serious — **alcance de accesibilidad (ej. WCAG) debe confirmarse con producto, no está especificado con un estándar concreto en los PDF fuente** | render | PENDIENTE |
| REQ-090 | Flujo E2E confirma que WhatsApp permite decisiones (botones/listas) pero no edición de matriz/propuesta | E2E | PENDIENTE |
| REQ-091 | Mensajes de prueba fuera de horario (7:00-22:00) se retienen salvo plazo <24h | unit | PENDIENTE |
| REQ-092 | Guardrail de voz: la palabra "confirmo" nunca ejecuta la herramienta de fijar precio en prueba adversarial | adversarial | PENDIENTE |
| REQ-093 | Test de contrato confirma disclosure de IA en los primeros segundos de voz/WhatsApp y transferencia a humano <10s | integración | PENDIENTE |
| REQ-094 | Confirmar con producto si se requiere app móvil nativa antes de cerrar el alcance de "móvil" como solo WhatsApp+web | — (decisión de producto) | PENDIENTE |
| REQ-095 | Escaneo de secretos (tipo gitleaks) limpio en cada corrida de CI | unit | PENDIENTE |
| REQ-096 | Tests de verificación HMAC y deduplicación por `event_id` en webhooks entrantes | unit | PENDIENTE |
| REQ-097 | Suite de red-teaming de inyección de prompt (PDF/WhatsApp maliciosos) integrada en CI y en verde | adversarial | PENDIENTE |
| REQ-098 | CI: grep de patrones DER/PKCS#8 y extensiones `.cer/.key/.pfx/.p12` vacío en todo el repo/Storage/logs | unit | PENDIENTE |
| REQ-099 | Revisión de almacenamiento cifrado y de flujo de decisión confirma minimización de RFC/CURP y ausencia de perfilado automático sin intervención humana | integración | PENDIENTE |
| REQ-100 | Motor de calendario aplica `norma_version`/`articulo_map` correctamente en casos de prueba — **bloqueado hasta VERIFICAR fecha de vigencia contra el DOF** | unit | PENDIENTE |
| REQ-101 | La matriz de cumplimiento marca correctamente el campo `causa_desechamiento` en el gold set | unit | PENDIENTE |
| REQ-102 | Umbral de precio no aceptable se aplica en casos de prueba — **bloqueado hasta VERIFICAR artículo contra el DOF** | unit | PENDIENTE |
| REQ-103 | Lectura del acta de fallo el mismo día se dispara en prueba de integración — **bloqueado hasta VERIFICAR cita legal contra el DOF** | integración | PENDIENTE |
| REQ-104 | Plazo de inconformidad se calcula en el motor — **bloqueado hasta VERIFICAR el plazo exacto contra el DOF (contradicción entre fuentes)** | unit | PENDIENTE |
| REQ-105 | Plazo de pago se calcula en el motor — **bloqueado hasta VERIFICAR 17 días hábiles vs. 20 naturales contra el DOF** | unit | PENDIENTE |
| REQ-106 | Porcentaje de garantía de cumplimiento se aplica en el motor — **bloqueado hasta VERIFICAR artículo exacto** | unit | PENDIENTE |
| REQ-107 | Tope de convenio modificatorio de obra (25%) se aplica en el motor — **bloqueado hasta VERIFICAR contra el DOF** | unit | PENDIENTE |
| REQ-108 | Simulador de puntos y porcentajes valida contra la rúbrica específica de cada convocatoria de prueba | unit | PENDIENTE |
| REQ-109 | Plantilla de manifiesto MIPyME incluye los campos obligatorios definidos | unit | PENDIENTE |
| REQ-110 | Umbral de adjudicación directa por tramo se aplica en el motor — **bloqueado hasta VERIFICAR contra el PEF vigente** | unit | PENDIENTE |
| REQ-111 | Matching de fingerprint de entidad detecta interpósita persona en el set de prueba sintético | integración | PENDIENTE |
| REQ-112 | Job nocturno de KYC negativo genera alerta ante coincidencia con lista 69-B/sancionados | integración | PENDIENTE |
| REQ-113 | Ningún manifiesto de prueba se emite sin evidencia y confirmación humana registrada | adversarial | PENDIENTE |
| REQ-114 | Suite de 200 prompts adversariales anticolusión/soborno: detección ≥99%, FP ≤2% | adversarial | PENDIENTE |
| REQ-115 | Leyenda de disclosure de IA presente en el 100% de artefactos generados en prueba | render | PENDIENTE |
| REQ-116 | Texto de banderas de riesgo revisado por abogado antes de publicarse (checklist de revisión, no automatizable) | — (revisión humana) | PENDIENTE |
| REQ-117 | Aviso legal de responsabilidad del licitante presente antes de cada envío de manifiesto en prueba E2E | E2E | PENDIENTE |
| REQ-118 | Diseño del producto documentado como "alto riesgo" en el registro de riesgos del proyecto | — (revisión de diseño) | PENDIENTE |
| REQ-119 | Aviso de privacidad publicado y vigente; RLS por tenant sobre tablas de datos personales verificado por pgTAP | unit | PENDIENTE |
| REQ-120 | Test confirma redacción de PII antes de cualquier llamada a un proveedor de LLM externo | unit | PENDIENTE |
| REQ-121 | Revisión legal de cláusulas de autoría en contratos de cliente — **bloqueado hasta VERIFICAR LFDA art. 12 contra el DOF** | — (revisión legal) | PENDIENTE |
| REQ-122 | Revisión legal de cada nueva fuente de scraping antes de activarla en el registro de conectores | — (revisión legal) | PENDIENTE |
| REQ-123 | Decisión de forma jurídica (S.A.P.I.) documentada y aprobada por el fundador antes del primer cobro | — (decisión reservada) | PENDIENTE |
| REQ-124 | Configuración de modelos por rol (barato/medio/caro) documentada y usada consistentemente en runs de prueba | unit | PENDIENTE |
| REQ-125 | Auditoría de configuración confirma que los 5 componentes de tolerancia cero siempre enrutan a proveedor EE.UU. | unit | PENDIENTE |
| REQ-126 | Evidencia de los 5 gates de cambio de modelo documentada en `tasks/evidence/` antes de cualquier cambio de enrutamiento | integración | PENDIENTE |
| REQ-127 | Verificador de entailment y juez de evals usan un modelo distinto del evaluado, con calibración documentada | unit | PENDIENTE |
| REQ-128 | `budget_cap` por corrida dispara alerta ante corridas simuladas que lo excedan | integración | PENDIENTE |
| REQ-129 | ≥70% de páginas de prueba se procesan con el motor local (Docling/PyMuPDF) sin costo marginal | unit | PENDIENTE |
| REQ-130 | Decisión de alcance de cuenta del proveedor de LLM documentada como aprobada por el fundador | — (decisión reservada) | PENDIENTE |
| REQ-131 | Aviso de privacidad y reporte de transparencia actualizados antes de activar cualquier enrutamiento alternativo | — (revisión legal) | PENDIENTE |
| REQ-132 | Conector a ComprasMX pasa pruebas de contrato diarias contra el sitio real (o fixture actualizado) | integración | PENDIENTE |
| REQ-133 | Conector OCDS/PDN-S6 valida el esquema de respuesta contra OCDS | integración | PENDIENTE |
| REQ-134 | Job de verificación cruzada contra el DOF opera sobre un set de prueba de convocatorias | integración | PENDIENTE |
| REQ-135 | Un conector genérico `/edca/...` cubre correctamente los portales estatales con ese patrón en prueba | integración | PENDIENTE |
| REQ-136 | Decisión de producto documentada sobre si se compromete un conector a PLACSP/TED en el roadmap | — (decisión de producto) | PENDIENTE |
| REQ-137 | Evidencias de cada tarea completa están presentes en `tasks/evidence/<id>/` | integración | PENDIENTE |
| REQ-138 | CI de evals de gate se ejecuta y bloquea el merge ante cambios de prompt/esquema/modelo sin evidencia | integración | PENDIENTE |
| REQ-139 | Ninguna tarea marcada `needs-human` se cierra sin aprobación explícita registrada del fundador | integración | PENDIENTE |
| REQ-140 | Estado actualizado de los bloqueos conocidos (verificación jurídica, HAR ComprasMX, plantillas WhatsApp) revisado antes de iniciar el módulo dependiente | — (revisión de gobierno) | PENDIENTE |

---

**Nota**: los criterios marcados con "bloqueado hasta VERIFICAR" (REQ-100, 102-107, 110, 121) no deben implementarse en el motor determinista de reglas legales hasta que el equipo confirme la norma/artículo/vigencia exacta contra la fuente oficial (DOF), tal como señalan explícitamente los propios documentos fuente (`DECISIONS-HUMANAS.md` y `tasks-licitaciones-FOCUS.md` del proyecto).
