/**
 * Bloques reusables del cuerpo de un correo. Cada plantilla en
 * `templates/catalog/*` compone su cuerpo con estos, en vez de reinventar
 * estilos inline por archivo — igual que las tarjetas de datos, el botón
 * píldora y el bloque de código son un solo componente en la app.
 */
import * as React from "react";
import { Button, Heading, Hr, Section, Text } from "@react-email/components";
import { colors, fonts, TONE_LABEL, type ToneKey } from "../theme";
import { safeUrl } from "../security/safe-url";

export function ToneBadge({ tone }: { tone?: ToneKey }): React.ReactElement | null {
  const t = TONE_LABEL[tone ?? "neutral"];
  if (!t.label) return null;
  return (
    <Text
      style={{
        margin: "0 0 14px 0",
        fontFamily: fonts.sans,
        fontSize: 10,
        lineHeight: "14px",
        fontWeight: 600,
        letterSpacing: "0.11em",
        textTransform: "uppercase",
        color: t.color,
      }}
    >
      <span style={{ color: t.color }}>&#9679;</span>&nbsp;&nbsp;{t.label}
    </Text>
  );
}

export function Title({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Heading
      as="h1"
      style={{
        margin: "0 0 18px 0",
        fontFamily: fonts.display,
        fontSize: 26,
        lineHeight: "34px",
        fontWeight: 600,
        letterSpacing: "-0.02em",
        color: colors.ink,
      }}
    >
      {children}
    </Heading>
  );
}

export function Paragraph({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text
      style={{
        margin: "0 0 16px 0",
        fontFamily: fonts.sans,
        fontSize: 15,
        lineHeight: "24px",
        color: colors.body,
      }}
    >
      {children}
    </Text>
  );
}

export interface DataRowItem {
  label: string;
  value: string;
}

/** El grid de datos nivel documento: etiqueta en versalitas espaciadas a la
 *  izquierda, valor en seminegrita a la derecha, un pelo de línea por fila. */
export function DataTable({ rows }: { rows: DataRowItem[] }): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      width="100%"
      style={{ margin: "26px 0 4px 0", borderCollapse: "collapse" }}
    >
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td
              style={{
                padding: "13px 0",
                borderTop: `1px solid ${colors.line}`,
                fontFamily: fonts.sans,
                fontSize: 10.5,
                lineHeight: "16px",
                fontWeight: 600,
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                color: colors.faint,
              }}
            >
              {row.label}
            </td>
            <td
              align="right"
              style={{
                padding: "13px 0",
                borderTop: `1px solid ${colors.line}`,
                fontFamily: fonts.sans,
                fontSize: 14,
                lineHeight: "20px",
                color: colors.ink,
                fontWeight: 600,
              }}
            >
              {row.value}
            </td>
          </tr>
        ))}
        <tr>
          <td colSpan={2} style={{ borderTop: `1px solid ${colors.line}`, fontSize: 0, lineHeight: 0 }}>
            &nbsp;
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export interface CtaButtonProps {
  label: string;
  href: string;
  /** El correo base de la app, para el fallback si `href` no es http(s). */
  appUrl: string;
  /**
   * Imprime la URL también como texto plano seleccionable, debajo del botón.
   * OBLIGATORIO en correos de acceso (verificación, invitación, restablecer
   * contraseña): los escáneres de correo corporativo reescriben o incluso
   * VISITAN el href antes que la persona, y un enlace de un solo uso ya
   * visitado por un robot deja de servir cuando el humano hace clic. Con la
   * liga literal a la vista, el peor caso es copiar y pegar.
   */
  showLiteralLink?: boolean;
}

export function CtaButton({ label, href, appUrl, showLiteralLink }: CtaButtonProps): React.ReactElement {
  const safeHref = safeUrl(href, appUrl);
  return (
    <>
      <Section style={{ margin: "30px 0 4px 0" }}>
        <Button
          href={safeHref}
          style={{
            display: "inline-block",
            backgroundColor: colors.brand,
            padding: "13px 26px",
            fontFamily: fonts.sans,
            fontSize: 14,
            lineHeight: "20px",
            fontWeight: 600,
            color: "#ffffff",
            textDecoration: "none",
            borderRadius: 999,
          }}
        >
          {label}
        </Button>
      </Section>
      {showLiteralLink ? (
        <Text
          style={{
            margin: "22px 0 0 0",
            fontFamily: fonts.sans,
            fontSize: 11.5,
            lineHeight: "18px",
            color: colors.faint,
          }}
        >
          ¿El botón no abre? Copia esta liga en tu navegador:
          <br />
          <span style={{ wordBreak: "break-all" }}>{safeHref}</span>
        </Text>
      ) : null}
    </>
  );
}

/**
 * El código de un solo uso (verificación, 2FA). Mono, grande y espaciado:
 * un código que hay que teclear se lee dígito por dígito, y agrupado
 * apretado se teclea mal — 1 y l, 0 y O no se confunden en monoespaciada.
 */
export function CodeBlock({ code, label = "Código de un solo uso" }: { code: string; label?: string }): React.ReactElement {
  return (
    <Section style={{ margin: "28px 0 4px 0" }}>
      <Text
        style={{
          margin: "0 0 9px 0",
          fontFamily: fonts.sans,
          fontSize: 10,
          lineHeight: "14px",
          fontWeight: 600,
          letterSpacing: "0.11em",
          textTransform: "uppercase",
          color: colors.faint,
        }}
      >
        {label}
      </Text>
      <table role="presentation" cellPadding={0} cellSpacing={0} width="100%">
        <tbody>
          <tr>
            <td
              align="center"
              style={{
                backgroundColor: colors.well,
                padding: "17px 30px",
                border: `1px solid ${colors.line}`,
                borderRadius: 12,
                fontFamily: fonts.mono,
                fontSize: 27,
                lineHeight: "33px",
                fontWeight: 600,
                letterSpacing: "0.2em",
                color: colors.ink,
                whiteSpace: "nowrap",
              }}
            >
              {code}
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

/** Una lista de códigos de respaldo (2FA), en una cuadrícula mono de dos
 *  columnas — cada código es de un solo uso, por eso se numeran. */
export function BackupCodesGrid({ codes }: { codes: string[] }): React.ReactElement {
  const rows: string[][] = [];
  for (let i = 0; i < codes.length; i += 2) rows.push(codes.slice(i, i + 2));
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} width="100%" style={{ margin: "16px 0 4px 0" }}>
      <tbody>
        {rows.map((pair) => (
          <tr key={pair.join("-")}>
            {pair.map((c, j) => (
              <td
                key={c}
                style={{
                  padding: "10px 12px",
                  backgroundColor: colors.well,
                  border: `1px solid ${colors.line}`,
                  borderRadius: 8,
                  fontFamily: fonts.mono,
                  fontSize: 15,
                  letterSpacing: "0.08em",
                  color: colors.ink,
                  textAlign: "center",
                  paddingRight: j === 0 && pair.length > 1 ? 6 : 12,
                }}
              >
                {c}
              </td>
            ))}
            {pair.length === 1 ? <td style={{ padding: "10px 12px" }} /> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Nota al pie de la tarjeta (no del correo): qué hacer si no se pidió esto.
 *  En su propio bloque para que no se lea como parte del cuerpo. */
export function Callout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Section
      style={{
        margin: "26px 0 0 0",
        backgroundColor: colors.canvas,
        border: `1px solid ${colors.line}`,
        borderRadius: 10,
        padding: "15px 18px",
      }}
    >
      <Text style={{ margin: 0, fontFamily: fonts.sans, fontSize: 12, lineHeight: "19px", color: colors.muted }}>
        {children}
      </Text>
    </Section>
  );
}

export function Divider(): React.ReactElement {
  return <Hr style={{ borderColor: colors.line, margin: "26px 0" }} />;
}
