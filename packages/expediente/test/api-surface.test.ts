import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as expediente from "../src/index.js";

/**
 * A15 (firma/envío siempre a cargo del usuario, REQ-045/REQ-046/REQ-165):
 * este paquete jamás debe exponer una función que envíe, firme o actúe en
 * nombre del usuario. Se verifica en dos niveles:
 *  1. La API pública exportada (runtime) no contiene ningún método cuyo
 *     nombre sugiera envío/firma/actuación automática.
 *  2. El código fuente no importa clientes HTTP/red (ningún módulo de este
 *     paquete puede, por construcción, llamar a un portal externo).
 */

const FORBIDDEN_NAME_PATTERN = /(submit|enviar|send|firmar|sign|upload_to|act_on_portal|contact_third_party)/i;
// Excepciones deliberadas: nombres que matchean el patrón por accidente léxico
// ("sign" dentro de "signer" = firmante, no "firmar") pero no envían/firman
// nada — solo LEEN quién es el firmante autorizado y si el usuario YA marcó
// (fuera del sistema) que firmó. Se documentan explícitamente aquí, ninguna
// oculta; si la lista crece sin justificación, la prueba debe fallar.
const ALLOWED_EXCEPTIONS = new Set<string>(["getSigners", "resolveAuthorizedSigner"]);

describe("A15 — superficie pública sin envío/firma/actuación automática", () => {
  it("ningún export de nivel superior sugiere enviar, firmar o actuar en un portal", () => {
    const offending = Object.keys(expediente).filter(
      (name) => FORBIDDEN_NAME_PATTERN.test(name) && !ALLOWED_EXCEPTIONS.has(name),
    );
    expect(offending).toEqual([]);
  });

  it("ninguna clase pública expone un método de instancia que envíe/firme/actúe", () => {
    const offending: string[] = [];
    for (const [exportName, value] of Object.entries(expediente)) {
      if (typeof value !== "function" || !value.prototype) continue;
      const methodNames = Object.getOwnPropertyNames(value.prototype).filter((n) => n !== "constructor");
      for (const methodName of methodNames) {
        if (FORBIDDEN_NAME_PATTERN.test(methodName) && !ALLOWED_EXCEPTIONS.has(methodName)) {
          offending.push(`${exportName}.${methodName}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it("IntegrityChecklist solo puede marcar firmas como 'requiere firma del usuario', nunca como firmadas por el sistema", () => {
    // Verificación estructural: el checklist depende de un flag provisto por
    // el llamador (`userConfirmedSigned`); no existe ningún método que ponga
    // ese flag en `true` desde dentro del paquete.
    const source = readFileSync(join(import.meta.dirname, "..", "src", "integrity-checklist.ts"), "utf8");
    expect(source).not.toMatch(/userConfirmedSigned\s*=\s*true/);
  });

  it("ningún archivo fuente del paquete importa un cliente HTTP/red (fetch/axios/http/https)", () => {
    const srcDir = join(import.meta.dirname, "..", "src");
    const offendingFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const content = readFileSync(full, "utf8");
          if (/from\s+["'](node:)?(https?|axios|node-fetch)["']/.test(content) || /\bfetch\(/.test(content)) {
            offendingFiles.push(full);
          }
        }
      }
    };
    walk(srcDir);
    expect(offendingFiles).toEqual([]);
  });
});
