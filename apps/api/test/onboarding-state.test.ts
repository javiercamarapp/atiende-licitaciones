import { describe, it, expect } from 'vitest';
import { FakeProvider } from '@atiende/agents';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * Patrón Likida/atiende.ai #7 (onboarding conversacional con guardas
 * deterministas): `GET /onboarding/state` -- ver
 * `apps/api/src/modules/onboarding/routes.ts` y
 * `packages/agents/src/onboarding.ts`. Verifica de punta a punta, contra
 * datos REALES (organización/perfil/invitaciones/documentos ya
 * persistidos, nada simulado), que:
 *  - el orden de preguntas sigue exactamente al wizard actual;
 *  - `isComplete` nunca es `true` mientras falte organización/RFC/giro
 *    (la GUARDA determinista, el criterio central del patrón);
 *  - `nextAction` siempre apunta a un endpoint YA existente del wizard
 *    (nunca a uno duplicado);
 *  - la redacción del `LLMProvider` configurado se usa cuando responde
 *    contenido real, y se degrada al texto canónico con el
 *    `FakeProvider` por defecto (sin `OPENAI_API_KEY`).
 */
describe('Patrón #7: GET /onboarding/state', () => {
  it('sin organización: pregunta por la organización, isComplete=false, nextAction crea la organización', async () => {
    const { app, db } = await createTestApp();
    try {
      const user = await registerAndLogin(app, 'p7-fresh@example.com');
      const res = await app.inject({
        method: 'GET',
        url: '/onboarding/state',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.hasOrganization).toBe(false);
      expect(body.orgId).toBeNull();
      expect(body.missingRequired).toEqual(['organization', 'legalName', 'taxId', 'sector']);
      expect(body.isComplete).toBe(false);
      expect(body.nextField).toBe('organization');
      expect(body.questionSource).toBe('canned');
      expect(body.nextAction).toEqual({ method: 'POST', path: '/organizations', hint: expect.any(String) });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('con organización pero sin perfil: pregunta por legalName, y nextAction apunta a PUT /company/profile', async () => {
    const { app, db } = await createTestApp();
    try {
      const user = await registerAndLogin(app, 'p7-org-only@example.com');
      const org = await createOrgFor(app, user, 'Patrón 7 Org', 'p7-org-1');

      const res = await app.inject({
        method: 'GET',
        url: '/onboarding/state',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
      });
      const body = res.json();
      expect(body.orgId).toBe(org.id);
      expect(body.hasOrganization).toBe(true);
      expect(body.missingRequired).toEqual(['legalName', 'taxId', 'sector']);
      expect(body.isComplete).toBe(false);
      expect(body.nextField).toBe('legalName');
      expect(body.nextAction).toEqual({ method: 'PUT', path: '/company/profile', hint: expect.any(String) });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('sin X-Org-Id, resuelve a la primera organización propia del usuario (mismo criterio que app.my_organizations)', async () => {
    const { app, db } = await createTestApp();
    try {
      const user = await registerAndLogin(app, 'p7-no-header@example.com');
      const org = await createOrgFor(app, user, 'Patrón 7 Org NH', 'p7-org-nh');

      const res = await app.inject({
        method: 'GET',
        url: '/onboarding/state',
        headers: { authorization: `Bearer ${user.accessToken}` }, // SIN x-org-id
      });
      expect(res.json().orgId).toBe(org.id);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('un X-Org-Id de una organización ajena NUNCA se usa: se degrada a la propia (o a ninguna)', async () => {
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'p7-other-owner@example.com');
      const otherOrg = await createOrgFor(app, owner, 'Ajena', 'p7-org-ajena');

      const stranger = await registerAndLogin(app, 'p7-stranger@example.com'); // sin ninguna organización propia
      const res = await app.inject({
        method: 'GET',
        url: '/onboarding/state',
        headers: { authorization: `Bearer ${stranger.accessToken}`, 'x-org-id': otherOrg.id },
      });
      const body = res.json();
      expect(body.orgId).toBeNull();
      expect(body.hasOrganization).toBe(false);
      expect(body.nextField).toBe('organization');
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('la GUARDA determinista: isComplete sigue false mientras falte AUNQUE SEA UNO de organización/RFC/giro, campo por campo', async () => {
    const { app, db } = await createTestApp();
    try {
      const user = await registerAndLogin(app, 'p7-guard@example.com');
      const org = await createOrgFor(app, user, 'Patrón 7 Guard', 'p7-org-guard');

      // legalName + taxId, SIN sector (el wizard actual lo trata como
      // opcional -- este flujo lo endurece a obligatorio, ver
      // packages/agents/test/onboarding.test.ts).
      const put1 = await app.inject({
        method: 'PUT',
        url: '/company/profile',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { legalName: 'Mi Empresa S.A. de C.V.', taxId: 'MEM990101AB1' },
      });
      expect(put1.statusCode).toBe(200);

      const stateAfterProfile = await app.inject({
        method: 'GET',
        url: '/onboarding/state',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
      });
      const body1 = stateAfterProfile.json();
      expect(body1.legalName).toBe('Mi Empresa S.A. de C.V.');
      expect(body1.taxId).toBe('MEM990101AB1');
      expect(body1.missingRequired).toEqual(['sector']);
      expect(body1.isComplete).toBe(false); // GUARDA: sigue false, falta el giro.
      expect(body1.nextField).toBe('sector');

      // Completa el giro: ahora sí.
      const put2 = await app.inject({
        method: 'PUT',
        url: '/company/profile',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { legalName: 'Mi Empresa S.A. de C.V.', taxId: 'MEM990101AB1', sector: 'Construcción' },
      });
      expect(put2.statusCode).toBe(200);

      const stateComplete = await app.inject({
        method: 'GET',
        url: '/onboarding/state',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
      });
      const body2 = stateComplete.json();
      expect(body2.missingRequired).toEqual([]);
      expect(body2.isComplete).toBe(true);
      // Con los 4 obligatorios completos, pasa a los opcionales (equipo primero).
      expect(body2.nextField).toBe('team');
      expect(body2.nextAction).toEqual({ method: 'POST', path: '/organizations/invitations', hint: expect.any(String) });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('tras invitar a alguien y subir un documento, no queda nada pendiente: nextField=null, nextAction=null', async () => {
    const { app, db } = await createTestApp();
    try {
      const user = await registerAndLogin(app, 'p7-full@example.com');
      const org = await createOrgFor(app, user, 'Patrón 7 Full', 'p7-org-full');
      await app.inject({
        method: 'PUT',
        url: '/company/profile',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { legalName: 'Mi Empresa S.A. de C.V.', taxId: 'MEM990101AB1', sector: 'Construcción' },
      });

      const invite = await app.inject({
        method: 'POST',
        url: '/organizations/invitations',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { email: 'colega@example.com', role: 'writer' },
      });
      expect(invite.statusCode).toBe(201);

      const contentBase64 = Buffer.from('constancia de situación fiscal de prueba').toString('base64');
      const upload = await app.inject({
        method: 'POST',
        url: '/company/documents',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { documentType: 'constancia_situacion_fiscal', contentBase64 },
      });
      expect(upload.statusCode).toBe(201);

      const res = await app.inject({
        method: 'GET',
        url: '/onboarding/state',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
      });
      const body = res.json();
      expect(body.teamInvited).toBe(true);
      expect(body.firstDocumentUploaded).toBe(true);
      expect(body.missingRequired).toEqual([]);
      expect(body.missingOptional).toEqual([]);
      expect(body.isComplete).toBe(true);
      expect(body.nextField).toBeNull();
      expect(body.nextAction).toBeNull();
      expect(body.questionSource).toBe('canned'); // el cierre SIEMPRE es canónico, ver onboarding.ts
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('con un LLMProvider que SÍ redacta contenido real, questionSource="llm" y el texto es el que redactó el proveedor', async () => {
    const scriptedProvider = new FakeProvider(() => ({
      content: '¡Hola! Para empezar, cuéntame el nombre de tu organización.',
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 10 },
    }));
    const { app, db } = await createTestApp({}, { llmProvider: scriptedProvider });
    try {
      const user = await registerAndLogin(app, 'p7-llm@example.com');
      const res = await app.inject({
        method: 'GET',
        url: '/onboarding/state',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      const body = res.json();
      expect(body.questionSource).toBe('llm');
      expect(body.question).toBe('¡Hola! Para empezar, cuéntame el nombre de tu organización.');
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('sin autenticación, responde 401', async () => {
    const { app, db } = await createTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/onboarding/state' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
