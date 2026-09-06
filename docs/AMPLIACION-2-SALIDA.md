# Ampliación 2 — Salida a promoción (nivel Likida / Atiende Restaurantes)

Fecha: 2026-09-06. Origen: instrucción del usuario: «quiero que esté todo de punta a punta nivel Likida o Atiende Restaurantes: auth de Google ya listo, correos listos y editados con plantilla como Likida; todo exactamente para salir a promoción».

## Alcance obligatorio
1. **Autenticación con Google** (OIDC) además de email+contraseña: botón en login/registro, vinculación de cuenta existente por email verificado, creación de usuario + primera organización, sesión y refresh iguales que hoy, 2FA compatible, audit_log. Sin credenciales reales de Google en el repo: `GOOGLE_CLIENT_ID/SECRET` por env; flujo real verificable solo cuando el usuario aporte credenciales (bloqueo externo hasta entonces; el flujo se prueba con un proveedor OIDC falso y con contrato de tokens real).
2. **Correos transaccionales con plantillas** al estilo Likida (misma estructura, tono y componentes; marca Atiende): verificación de email, invitación a organización, restablecimiento de contraseña, códigos de respaldo/activación de 2FA, alertas de nuevas convocatorias y cambios, matching relevante, aprobación pendiente, paquete listo, recordatorios y vencimientos post-adjudicación, resumen diario/semanal. Proveedor por env (Resend/Postmark/SMTP) con adaptador y bandeja de captura en desarrollo; previsualización de plantillas; textos editados en español de México; enlaces firmados; baja/preferencias por usuario; registro de envíos con estado y reintentos (jobs); nunca a terceros no registrados.
3. **Onboarding de producto**: registro → verificación → crear organización → perfil de empresa guiado → invitar equipo → primera convocatoria; estados vacíos con guía; checklist de activación.
4. **Páginas públicas**: landing de Atiende Licitaciones con la identidad de Atiende (Restaurantes) y estructura de Likida (propuesta de valor, cómo funciona, seguridad/no actuación automática, precios o «solicitar demo» si no hay precios definidos), aviso de privacidad y términos (borrador jurídico marcado), contacto (formulario → correo interno + registro), SEO básico, analítica sin datos personales.
5. **Preparación de despliegue**: Dockerfiles, compose de producción (api, worker, web, postgres), variables documentadas, migraciones en arranque, healthchecks, backups, runbook de salida; sin desplegar ni gastar sin autorización.
6. **Calidad**: pruebas de integración y E2E de Google (falso OIDC), correos (captura), onboarding y landing; auditoría adversarial y reverificación como el resto.

## Bloqueos externos previstos (decisión del usuario)
- Credenciales OAuth de Google (consola de Google Cloud) y dominio autorizado.
- Proveedor de correo (Resend/Postmark/SMTP) y dominio remitente con SPF/DKIM.
- Dominio público, hosting y base de datos gestionada.
- Textos legales definitivos validados por abogado.
