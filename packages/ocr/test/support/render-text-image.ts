import { createCanvas } from "@napi-rs/canvas";

/**
 * Renderiza texto a un PNG en memoria -- SOLO para generar el fixture de
 * pruebas del adaptador real (`test/tesseract-adapter.test.ts`). Esto NO es
 * un gold set de documentos de licitación reales (no existe en este repo,
 * ver `docs/ACEPTACION.md`); es la única forma honesta de probar que
 * `TesseractOcrAdapter` ejecuta reconocimiento óptico GENUINO (no un mock)
 * sin depender de un archivo binario externo de procedencia dudosa.
 */
export function renderTextToPng(text: string, opts: { width?: number; height?: number; fontSize?: number } = {}): Buffer {
  const width = opts.width ?? 800;
  const height = opts.height ?? 200;
  const fontSize = opts.fontSize ?? 36;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillText(text, 24, Math.round(height / 2) + Math.round(fontSize / 3));
  return canvas.toBuffer("image/png");
}

/** Una imagen en blanco (sin texto) -- para probar el caso "página sin contenido reconocible". */
export function renderBlankPng(opts: { width?: number; height?: number } = {}): Buffer {
  const width = opts.width ?? 400;
  const height = opts.height ?? 200;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}
