import { HtmlValidate } from "html-validate";

/**
 * `html-validate:recommended` está pensado para páginas web, no para
 * correo. Varias de sus reglas señalan justo las técnicas que hacen que un
 * HTML de correo funcione en Outlook/Gmail/Apple Mail —desactivarlas aquí
 * NO es bajar el estándar, es apuntar el linter al estándar correcto (el
 * mismo criterio que Litmus/Email on Acid usan para lint de correo):
 *
 *   - `doctype-html`: el DOCTYPE XHTML Transitional que emite
 *     `@react-email/render` es el recomendado para correo (Outlook de
 *     escritorio lo respeta mejor que el `<!doctype html>` de HTML5).
 *   - `void-style`: los elementos vacíos autocerrados (`<meta/>`, `<br/>`)
 *     son sintaxis XHTML, válida y deliberada.
 *   - `element-permitted-content`: el `<div>` oculto del preheader
 *     (`Preview` de React Email) vive entre `</head>` y `<body>` a
 *     propósito — es el truco estándar para que Gmail no tome el wordmark
 *     como avance del correo; los clientes de correo lo toleran aunque no
 *     sea HTML5 estricto.
 *   - `no-deprecated-attr` / `attr-case`: `width`/`align`/`cellPadding`/
 *     `cellSpacing` en `<table>`/`<td>` son EXACTAMENTE lo que hace que la
 *     tabla se vea igual en el motor de Word de Outlook — deprecados en la
 *     web, obligatorios en correo.
 *   - `no-conditional-comment`: los comentarios `<!--[if mso]-->` del
 *     componente `Button` de React Email son la técnica estándar para
 *     ajustar el padding del botón solo en Outlook.
 *   - `no-inline-style`: TODO el CSS de un correo va inline a propósito
 *     (ver `components/EmailLayout.tsx`) — Gmail borra `<style>` del
 *     `<head>`.
 *   - `long-title`: es una regla de SEO para el `<title>` de una página
 *     web; la mayoría de los clientes de correo ni siquiera lo muestran, y
 *     el nuestro replica el asunto real (que sí puede pasar 70 caracteres
 *     con el nombre de una convocatoria).
 *
 * Todo lo demás del set recomendado sigue activo: etiquetas sin cerrar,
 * anidamiento inválido, atributos duplicados, ids repetidos, etc. siguen
 * marcando error — que es el bug real que esta prueba quiere atrapar.
 */
export function createEmailHtmlValidator(): HtmlValidate {
  return new HtmlValidate({
    extends: ["html-validate:recommended"],
    rules: {
      "doctype-html": "off",
      "void-style": "off",
      "element-permitted-content": "off",
      "no-deprecated-attr": "off",
      "attr-case": "off",
      "no-conditional-comment": "off",
      "no-inline-style": "off",
      "long-title": "off",
    },
  });
}
