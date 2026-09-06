# Backlog de Épicas — Atiende Licitaciones

Derivado de `docs/REQUISITOS.md` (REQ-001 a REQ-171) y `docs/ACEPTACION.md`. Orden = dependencia técnica primero, prioridad después. Cada épica declara: REQ asociados, paquete/app responsable, estado y las pruebas de aceptación (REQ de ACEPTACION.md y/o pruebas mínimas A1-A15) que cierra. Estado inicial de todo REQ/criterio: PENDIENTE salvo lo indicado como "en curso" (ronda 1, ver `docs/PROGRESO.md`).

## E1 — Fundamentos de plataforma (monorepo, esquema núcleo, runtime de agentes, conectores base)
**Estado: EN CURSO (ronda 1)** — web base, db+api núcleo, agents runtime, sources conectores, dispachados como agentes #5-#8.

| Paquete/app | Alcance |
|---|---|
| apps/web | Base Vite+React+TS+Tailwind+shadcn, layout/navegación paritaria con Restaurantes |
| apps/api | Fastify+zod+JWT, roles vía claims, idempotencia, rate limit, `audit_log` |
| packages/db | Esquema núcleo OCDS+MxCnet, RLS por tenant, migraciones probadas en PGlite |
| packages/agents | Runtime de agentes (registro de conectores, orquestador determinista por código) |
| packages/sources | Registro de conectores (`Source.fetch`/`Mapper.to_ocds`), raw lake inmutable |

REQ: REQ-004, REQ-005, REQ-007, REQ-008, REQ-057, REQ-058, REQ-062, REQ-063, REQ-068 a REQ-076, REQ-082, REQ-083, REQ-095, REQ-096.
Cierra (parcial, base técnica): REQ-004, REQ-005, REQ-057, REQ-058, REQ-068, REQ-070, REQ-071, REQ-073, REQ-074, REQ-083, REQ-095, REQ-096 de ACEPTACION.md.
Sin dependencias previas.

## E2 — Perfil de empresa y datos reales
**Estado: PENDIENTE** — depende de E1 (esquema y roles base).

| Paquete/app | Alcance |
|---|---|
| packages/db | Tablas de perfil (capacidades, experiencia, productos/servicios, ubicaciones, registros, documentos con vigencia, firmantes, restricciones) con columnas de procedencia (`owner`, `source`, `updated_at`) por campo |
| apps/api | Endpoints CRUD por categoría de perfil con autorización granular |
| apps/web | Pantallas de perfil de empresa (una por categoría) y edición de firmantes/restricciones |

REQ: REQ-141 a REQ-145 (sección 29), más REQ-022 a REQ-024, REQ-026 (bóveda documental aplicada al perfil).
Cierra: REQ-141 a REQ-145 de ACEPTACION.md; contribuye a A6 (dato ausente/contradictorio), A7 (documento/certificado vencido).

## E3 — Ingesta oficial y frescura
**Estado: PENDIENTE** — depende de E1 (registro de conectores, raw lake).

| Paquete/app | Alcance |
|---|---|
| packages/sources | Scheduler configurable por fuente, adaptador ComprasMX/DOF/OCDS-SHCP/PDN-S6/estatales con verificación puntual del portal oficial vigente, tabla `source_runs` |
| apps/api | Endpoints de estado/frescura por fuente |
| apps/web | Panel de fuentes y frescura en back office |

REQ: REQ-001, REQ-003, REQ-076, REQ-077, REQ-079, REQ-132 a REQ-136 (sección 27), REQ-146 a REQ-150 (sección 30).
Cierra: REQ-001, REQ-132 a REQ-135, REQ-146 a REQ-150 de ACEPTACION.md; A4 (fuente inaccesible y obsolescencia visible).

## E4 — Detección de cambios y versiones
**Estado: PENDIENTE** — depende de E3 (fuentes con `source_runs` operando).

| Paquete/app | Alcance |
|---|---|
| packages/db | `tender_versions`/historial, invalidación en cascada de dependientes |
| packages/sources | Diff de versiones, aclaraciones y anexos con dedupe por identidad+versión |
| packages/agents | Reglas de invalidación automática de tareas/matriz/propuestas dependientes |

REQ: REQ-017, REQ-041, REQ-151 a REQ-155 (sección 31).
Cierra: REQ-017, REQ-151 a REQ-155 de ACEPTACION.md; A1 (nueva publicación), A2 (duplicado/replay), A3 (modificación/aclaración y plazo adelantado).

## E5 — Matching por empresa (relevancia y elegibilidad)
**Estado: PENDIENTE** — depende de E2 (perfil real) y E4 (convocatorias versionadas y frescas).

| Paquete/app | Alcance |
|---|---|
| packages/agents | Motor de relevancia (semántico+léxico) y elegibilidad (reglas duras), score explicable separado |
| packages/db | `match_procedures` (pgvector+BM25), RLS |
| apps/api / apps/web | Exposición de ambos scores con evidencia y priorización |

REQ: REQ-002, REQ-006, REQ-009 a REQ-013, REQ-059 a REQ-061, REQ-111, REQ-166, REQ-167, REQ-168 (secciones 2, 3, 10, 24, 33).
Cierra: REQ-006, REQ-009 a REQ-013, REQ-059 a REQ-061, REQ-111, REQ-166 a REQ-168 de ACEPTACION.md; A5 (dos clientes, cero fuga), A6 (dato ausente/contradictorio, parcial).

## E6 — Análisis de bases y matriz de requisitos
**Estado: PENDIENTE** — depende de E4 (versión de bases estable a analizar).

| Paquete/app | Alcance |
|---|---|
| packages/agents | Pipeline de extracción (Docling/PyMuPDF + OCR por excepción), verificación de citas, simulador de puntaje |
| packages/db | Matriz de requisitos con campos de gestión (fuente/página/cláusula/obligatoriedad/responsable/fecha/evidencia/estado) |
| apps/web | Visor de bases con citas resaltadas |

REQ: REQ-014 a REQ-021, REQ-101, REQ-108, REQ-156 (secciones 4, 23, 32).
Cierra: REQ-014 a REQ-021, REQ-101, REQ-108, REQ-156 de ACEPTACION.md; contribuye a A9 (anexo obligatorio faltante, detección).

## E7 — Expediente de participación (propuesta técnica+económica+anexos+checklist)
**Estado: PENDIENTE** — depende de E2 (datos/tarifas aprobados), E5 (elegibilidad confirmada), E6 (matriz de requisitos).
**Paquete nuevo propuesto**: `packages/expediente` (orquesta generación de propuesta, checklist y paquete a partir de packages/db + packages/agents; evita acoplar esta lógica de dominio dentro de packages/agents genérico).

| Paquete/app | Alcance |
|---|---|
| packages/expediente (nuevo) | Generación de propuesta técnica/económica desde datos APROBADOS, checklist de integridad, versionado con hashes de insumos, invalidación de aprobación por cambio |
| packages/db | `price_catalog` aprobado, `approvals` con invalidación, `package_manifests` |
| packages/agents | Redactor/Auditor reutilizados desde E1/E6, guardrail `no_unsourced_claims` |
| apps/web | Editor de expediente, checklist visual, borrador vs. listo |

REQ: REQ-022 a REQ-036, REQ-037, REQ-038, REQ-048, REQ-157 a REQ-163 (secciones 5, 6, 7, 8, 32).
Cierra: REQ-022 a REQ-036, REQ-048, REQ-157 a REQ-163 de ACEPTACION.md; A7 (documento vencido), A8 (precio no aprobado), A9 (anexo faltante), A10 (cálculo económico), A11 (edición invalida aprobación), A13 (expediente completo descargable), A14 (expediente incompleto nunca listo).

## E8 — Auditoría, aprobación y entrega
**Estado: PENDIENTE** — depende de E7 (expediente generado y checklist en verde/ámbar).

| Paquete/app | Alcance |
|---|---|
| packages/agents | Auditor con 5 puertas deterministas + juez LLM distinto del redactor |
| apps/api | Máquina de estados del paquete, `needs_approval`/HITL, doble confirmación económica con re-autenticación |
| apps/web | Flujos de aprobación 1/2-2/2, descarga autenticada, sala de guerra |

REQ: REQ-037 a REQ-047, REQ-062 a REQ-064, REQ-161, REQ-162, REQ-165 (secciones 7, 8, 11, 32, 33).
Cierra: REQ-037 a REQ-047, REQ-062 a REQ-064 de ACEPTACION.md; A11 (edición invalida aprobación), A12 (autorización desde rol indebido), A15 (firma/envío siempre del usuario).

## E9 — Reglas duras de seguridad y no-actuación (transversal)
**Estado: PENDIENTE** — depende de E1; se integra de forma cruzada en E2, E5, E7, E8 conforme se construyen.

| Paquete/app | Alcance |
|---|---|
| packages/agents | Guardrails de entrada/salida: no inventar datos/precios/certificaciones, no actuar sin autorización específica, ausencia=pendiente |
| apps/api | Enforcement server-side de las mismas reglas (no solo en el prompt) |

REQ: REQ-045 a REQ-047, REQ-068, REQ-072, REQ-097, REQ-114, REQ-164 a REQ-167 (secciones 8, 13, 22, 24, 33).
Cierra: REQ-072, REQ-097, REQ-114, REQ-164 a REQ-167 de ACEPTACION.md; A6, A8, A12, A15 (como capa de guardrail transversal a las épicas de dominio).

## E10 — Back office / superadmin y observabilidad
**Estado: PENDIENTE (arranca en paralelo con E1, se completa según avanzan E3/E7/E8)**

| Paquete/app | Alcance |
|---|---|
| apps/web | Pantallas de conectores/frescura, jobs/reintentos, costos/límites IA, evals, incidentes, aprobaciones |
| apps/api | Endpoints de métricas honestas y trazas correlacionadas |
| packages/db | Vistas de auditoría, `correlation_id` extremo a extremo |

REQ: REQ-049, REQ-065 a REQ-067, REQ-086 a REQ-089, REQ-169 a REQ-171 (secciones 8, 12, 19, 20, 33).
Cierra: REQ-049, REQ-065 a REQ-067, REQ-086 a REQ-089, REQ-169 a REQ-171 de ACEPTACION.md.

## E11 — Seguimiento post-adjudicación
**Estado: PENDIENTE** — depende de E7/E8 (expediente entregado y adjudicado).

| Paquete/app | Alcance |
|---|---|
| packages/agents | Cobranza, autopsia del fallo, inconformidades, radar de renovaciones |
| packages/db | Máquina de estados del contrato, extracción estructurada del contrato firmado |
| apps/web | Seguimiento de contrato, calendario legal |

REQ: REQ-050 a REQ-056 (sección 9).
Cierra: REQ-050 a REQ-056 de ACEPTACION.md.

## E12 — Verificación del marco legal mexicano (gate transversal, no bloquea desarrollo técnico)
**Estado: PENDIENTE / bloqueado en los puntos marcados VERIFICAR** — corre en paralelo desde el inicio; sus resultados condicionan qué se puede codificar como "cumplido" en E7/E8/E11.

| Paquete/app | Alcance |
|---|---|
| (sin paquete de código; gobierno/legal) | Verificación contra DOF de vigencias LAASSP, plazo de pago, garantías, topes de convenio, umbrales PEF |

REQ: REQ-100 a REQ-123 (secciones 23, 24, 25).
Cierra: REQ-100 a REQ-123 de ACEPTACION.md (varios permanecen "bloqueado hasta VERIFICAR" hasta evidencia oficial). No bloquea E1-E11 salvo el motor determinista de plazos/montos legales específicos que dependan de la cifra exacta en disputa.

## E0 — Gobierno del ciclo de construcción (continuo, no secuencial)
**Estado: EN CURSO** — aplica a todas las épicas desde el inicio.

REQ: REQ-124 a REQ-131, REQ-137 a REQ-140 (secciones 26, 28).
Cierra: REQ-124 a REQ-131, REQ-137 a REQ-140 de ACEPTACION.md.

---

## Orden de ejecución sugerido (dependencia → prioridad)

1. **E1** (en curso) — fundamentos
2. **E3** y **E2** (pendiente, en paralelo, ambas dependen solo de E1)
3. **E4** (depende de E3)
4. **E6** (depende de E4) y **E5** (depende de E2+E4), en paralelo
5. **E9** (transversal, se integra desde que existe algo que guardar — arranca junto con E2/E5/E7)
6. **E7** (depende de E2+E5+E6)
7. **E8** (depende de E7)
8. **E10** (arranca en paralelo con E1, se completa según avanzan E3/E7/E8)
9. **E11** (depende de E7/E8)
10. **E12** y **E0** — transversales, corren durante todo el ciclo sin bloquear el desarrollo técnico salvo en las cifras legales marcadas VERIFICAR

Las 15 pruebas mínimas obligatorias de la ampliación (A1-A15, ver `docs/ACEPTACION.md`) quedan cubiertas, en conjunto, por el cierre de E3, E4, E5, E7, E8 y E9.
