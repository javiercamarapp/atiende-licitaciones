/**
 * Términos de servicio (ronda 7, docs/REQUISITOS.md §34.4): a diferencia
 * del aviso de privacidad (`/privacidad`), NO existe ningún endpoint en
 * apps/api equivalente a `GET /legal/privacy-notice` para términos de
 * servicio (se verificó el listado completo de rutas en
 * apps/api/README.md) — apps/api está fuera del alcance de esta ronda (ver
 * encargo), así que este contenido vive como una constante estática en
 * apps/web en vez de fingir una integración que no existe. Si una ronda
 * futura agrega `GET /legal/terms-of-service` en apps/api, este archivo
 * debe reemplazarse por una llamada real (mismo patrón que
 * lib/api/legal.ts).
 *
 * Cada decisión que exige criterio jurídico (jurisdicción, límites de
 * responsabilidad, vigencia, ley aplicable exacta) queda marcada
 * explícitamente con `FaltaDato` en vez de un valor inventado — ningún
 * abogado mexicano ha validado este documento todavía.
 */
export const TERMS_STATUS = "borrador_pendiente_validacion_juridica" as const;
export const TERMS_VERSION = 1;
export const TERMS_LAST_UPDATED = "2026-09-06";

export const TERMS_CONTENT_MARKDOWN = `
# Términos de servicio

## 1. Objeto del servicio

Atiende Licitaciones ("la Plataforma") es una herramienta de apoyo a la decisión y de organización documental para participar en licitaciones públicas en México: descubrimiento de convocatorias, cálculo de relevancia/elegibilidad ("matching"), armado de expediente (matriz de requisitos, propuesta técnica/económica, checklist de integridad) y seguimiento post-adjudicación.

## 2. Lo que la Plataforma NUNCA hace

- No presenta ni envía tu propuesta ante ninguna convocante, comité o plataforma oficial de contrataciones.
- No firma documentos, actas ni declaraciones en tu nombre.
- No contacta a ninguna dependencia, comité o convocante en tu representación.
- No garantiza el resultado de ninguna licitación ni la elegibilidad legal definitiva de tu empresa — el matching es una estimación basada en los datos que capturas, no una resolución de la convocante.

## 3. Responsabilidad de tu empresa

Tu empresa (u organización) es la única responsable de: verificar la vigencia y exactitud de los documentos que sube, decidir su participación (Go/No-Go), aprobar tarifas y expedientes con las personas autorizadas correspondientes, y presentar la propuesta por el canal oficial que exija cada convocatoria dentro del plazo aplicable.

FaltaDato: límite de responsabilidad económica de la Plataforma frente a un usuario (tope, exclusiones) — pendiente de definición jurídica y comercial antes de publicar como definitivo.

## 4. Cuentas, roles y seguridad

El acceso es por cuenta individual con contraseña y, para acciones sensibles (aprobación de tarifas y de expediente), verificación en dos pasos (2FA). Cada organización administra sus propios roles y membresías. Eres responsable de mantener la confidencialidad de tus credenciales y de notificar cualquier uso no autorizado.

## 5. Datos personales

El tratamiento de datos personales se rige por el aviso de privacidad (enlazado al pie de esta página), documento independiente de estos términos y también pendiente de validación jurídica.

## 6. Vigencia vs. otras rondas de mejora

FaltaDato: vigencia del contrato, condiciones de renovación y causales de terminación anticipada — pendiente de definición comercial y jurídica (aún no existe checkout ni planes con precio publicado, ver la sección "Planes" de la página de inicio).

## 7. Propiedad intelectual

FaltaDato: alcance exacto de la licencia de uso otorgada sobre la Plataforma y titularidad de los documentos generados a partir de tus datos (propuestas, matrices, paquetes) — pendiente de definición jurídica.

## 8. Ley aplicable y jurisdicción

FaltaDato: ley aplicable exacta y tribunales competentes en caso de controversia — pendiente de validación por un abogado mexicano antes de publicar como definitivo. Como referencia no vinculante, el tratamiento de datos personales de esta plataforma se apoya en la Ley Federal de Protección de Datos Personales en Posesión de los Particulares vigente (ver aviso de privacidad).

## 9. Modificaciones a estos términos

Cualquier cambio sustantivo a este documento se publicará con una nueva versión y fecha de actualización visibles en esta misma página.
`.trim();
