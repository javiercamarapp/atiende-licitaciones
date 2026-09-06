import { describe, it, expect, afterEach } from 'vitest';
import { createTestApp } from './helpers.js';
import { startFakeOidcProvider } from './helpers/fake-oidc.js';
import {
  assertSecureIssuerUrl,
  assertConfiguredIssuerUrlIsSecure,
  loadGoogleOidcEnv,
  GoogleOidcInsecureIssuerError,
  GoogleOidcNotConfiguredError,
} from '../src/modules/auth/google/env.js';

/**
 * GO-03 (docs/auditoria-2/api-google.md, hardening): `OIDC_ISSUER_URL`
 * gobierna TODO el flujo OIDC -- de él salen el documento de discovery, el
 * JWKS con el que se verifica la firma de cada `id_token` y el token
 * endpoint. Antes de esta reparación se aceptaba cualquier esquema: un
 * `http://` mal puesto en un despliegue real haría viajar los tres en claro,
 * y quien estuviera en la ruta podría servir su propio JWKS y firmar
 * `id_token`s que esta API daría por buenos.
 *
 * La reparación exige `https://`, con UNA sola excepción explícita y
 * estrecha: el proveedor OIDC FALSO de las pruebas
 * (`test/helpers/fake-oidc.ts`), que por construcción escucha en loopback --
 * y ni siquiera eso se admite bajo `NODE_ENV=production`.
 */
describe('GO-03: OIDC_ISSUER_URL debe usar https (excepto el proveedor falso en loopback)', () => {
  const savedIssuer = process.env.OIDC_ISSUER_URL;

  afterEach(() => {
    if (savedIssuer === undefined) delete process.env.OIDC_ISSUER_URL;
    else process.env.OIDC_ISSUER_URL = savedIssuer;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
  });

  it('acepta https (incluido el default real de Google) y rechaza http contra un host que no es loopback', () => {
    expect(() => assertSecureIssuerUrl('https://accounts.google.com')).not.toThrow();
    expect(() => assertSecureIssuerUrl('https://login.example.com/oidc')).not.toThrow();

    expect(() => assertSecureIssuerUrl('http://accounts.google.com')).toThrow(GoogleOidcInsecureIssuerError);
    expect(() => assertSecureIssuerUrl('http://idp.interno.example')).toThrow(GoogleOidcInsecureIssuerError);
    // Un host cuyo NOMBRE contiene "localhost" pero no lo es: no cuela.
    expect(() => assertSecureIssuerUrl('http://localhost.atacante.example')).toThrow(GoogleOidcInsecureIssuerError);
  });

  it('rechaza esquemas que no son http/https y valores que ni siquiera son una URL absoluta', () => {
    expect(() => assertSecureIssuerUrl('ftp://accounts.google.com')).toThrow(GoogleOidcInsecureIssuerError);
    expect(() => assertSecureIssuerUrl('javascript:alert(1)')).toThrow(GoogleOidcInsecureIssuerError);
    expect(() => assertSecureIssuerUrl('accounts.google.com')).toThrow(GoogleOidcInsecureIssuerError);
    expect(() => assertSecureIssuerUrl('')).toThrow(GoogleOidcInsecureIssuerError);
  });

  it('admite http SOLO en loopback (el proveedor falso de pruebas) y nunca bajo NODE_ENV=production', () => {
    const dev = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    expect(() => assertSecureIssuerUrl('http://127.0.0.1:45871', dev)).not.toThrow();
    expect(() => assertSecureIssuerUrl('http://localhost:45871', dev)).not.toThrow();
    expect(() => assertSecureIssuerUrl('http://[::1]:45871', dev)).not.toThrow();

    const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(() => assertSecureIssuerUrl('http://127.0.0.1:45871', prod)).toThrow(GoogleOidcInsecureIssuerError);
    // https en loopback sigue siendo válido incluso en producción: el
    // hallazgo es sobre el ESQUEMA, no sobre el host.
    expect(() => assertSecureIssuerUrl('https://127.0.0.1:45871', prod)).not.toThrow();
  });

  it('el mensaje de error nombra la variable, el valor y la única excepción admitida', () => {
    let message = '';
    try {
      assertSecureIssuerUrl('http://idp.interno.example');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('OIDC_ISSUER_URL');
    expect(message).toContain('http://idp.interno.example');
    expect(message).toContain('https://');
    expect(message).toContain('127.0.0.1');
    expect(message).toContain('GO-03');
  });

  it('loadGoogleOidcEnv falla con el issuer inseguro (defensa en profundidad) y sigue exigiendo antes las credenciales', () => {
    const insecure: NodeJS.ProcessEnv = {
      GOOGLE_CLIENT_ID: 'x',
      GOOGLE_CLIENT_SECRET: 'y',
      GOOGLE_REDIRECT_URI: 'https://app.example.test/auth/google/callback',
      OIDC_ISSUER_URL: 'http://idp.interno.example/',
      NODE_ENV: 'test',
    };
    expect(() => loadGoogleOidcEnv(insecure)).toThrow(GoogleOidcInsecureIssuerError);

    // Sin credenciales, el error sigue siendo el de REQ-178 (BLOQUEADO_EXTERNO),
    // no el de issuer: no se cambió el orden de comprobaciones.
    expect(() => loadGoogleOidcEnv({ OIDC_ISSUER_URL: 'http://idp.interno.example' })).toThrow(GoogleOidcNotConfiguredError);

    // El camino feliz sigue intacto, con y sin barra final.
    expect(loadGoogleOidcEnv({ ...insecure, OIDC_ISSUER_URL: 'https://login.example.com/oidc/' }).issuerUrl).toBe(
      'https://login.example.com/oidc'
    );
    expect(loadGoogleOidcEnv({ ...insecure, OIDC_ISSUER_URL: undefined }).issuerUrl).toBe('https://accounts.google.com');
  });

  it('assertConfiguredIssuerUrlIsSecure no dice nada cuando el operador no fijó la variable (el default ya es https)', () => {
    expect(() => assertConfiguredIssuerUrlIsSecure({})).not.toThrow();
    expect(() => assertConfiguredIssuerUrlIsSecure({ OIDC_ISSUER_URL: '   ' })).not.toThrow();
    expect(() => assertConfiguredIssuerUrlIsSecure({ OIDC_ISSUER_URL: 'http://idp.interno.example' })).toThrow(
      GoogleOidcInsecureIssuerError
    );
  });

  it('la API NO ARRANCA con un OIDC_ISSUER_URL inseguro (falla al construir la app, no en la primera petición)', async () => {
    process.env.OIDC_ISSUER_URL = 'http://idp.interno.example';
    await expect(createTestApp({ rateLimitProfile: 'e2e' })).rejects.toThrow(/OIDC_ISSUER_URL/);
  });

  it('la API sí arranca con el proveedor OIDC falso en loopback, y un issuer que se vuelve inseguro DESPUÉS responde 503 (nunca 500)', async () => {
    const provider = await startFakeOidcProvider();
    process.env.OIDC_ISSUER_URL = provider.issuerUrl;
    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret-not-real';
    process.env.GOOGLE_REDIRECT_URI = 'https://app.example.test/auth/google/callback';

    const { app, db } = await createTestApp({ rateLimitProfile: 'e2e' });
    try {
      // Arranque OK contra el proveedor falso (http en loopback) y flujo vivo.
      const ok = await app.inject({ method: 'GET', url: '/auth/google/start' });
      expect(ok.statusCode).toBe(200);
      expect(new URL(ok.json().authorizationUrl).origin).toBe(provider.issuerUrl);

      // Defensa en profundidad: si la variable se degrada en caliente, la
      // ruta responde el mismo 503 explícito de "no configurado", nunca un
      // 500 con una traza.
      process.env.OIDC_ISSUER_URL = 'http://idp.interno.example';
      const degraded = await app.inject({ method: 'GET', url: '/auth/google/start' });
      expect(degraded.statusCode).toBe(503);
      const body = degraded.json();
      expect(body.type).toBe('https://atiende.example/errors/google-oidc-not-configured');
      expect(String(body.title)).toContain('OIDC_ISSUER_URL');
      expect(degraded.body).not.toMatch(/\bat .+(routes|env)\.(ts|js)/);
    } finally {
      await app.close();
      await db.close();
      await provider.close();
    }
  });
});
