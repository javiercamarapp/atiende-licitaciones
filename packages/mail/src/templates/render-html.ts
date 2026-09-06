import { render } from "@react-email/render";
import type * as React from "react";

/** Arma las dos salidas (`html`, `text`) de un mismo árbol de React Email.
 *  `plainText: true` usa `html-to-text` internamente — la versión en texto
 *  plano nunca se redacta a mano ni puede quedar desincronizada del HTML. */
export async function renderEmailParts(element: React.ReactElement): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}
