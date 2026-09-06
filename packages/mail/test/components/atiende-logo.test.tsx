import * as React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@react-email/render";
import { AtiendeLogoMark, AtiendeWordmarkText } from "../../src/components/AtiendeLogo";

describe("AtiendeLogoMark", () => {
  it("renderiza un <svg> con el viewBox y los tres colores de marca", async () => {
    const html = await render(<AtiendeLogoMark />);
    expect(html).toContain("viewBox=\"0 0 40 32\"");
    expect(html).toContain("#7dd3fc"); // skyLight (lowercased por el renderer)
    expect(html).toContain("#38bdf8"); // sky
    expect(html).toContain("#1d4ed8"); // brand
  });

  it("escala el ancho proporcional al alto pedido", async () => {
    const html = await render(<AtiendeLogoMark height={64} />);
    expect(html).toContain('height="64"');
    expect(html).toContain('width="80"'); // 64 * 40/32
  });
});

describe("AtiendeWordmarkText", () => {
  it("renderiza el texto 'atiende' en el color de marca", async () => {
    const html = await render(<AtiendeWordmarkText />);
    expect(html).toContain(">atiende<");
    expect(html).toContain("#1d4ed8");
  });

  it("acepta un fontSize custom", async () => {
    const html = await render(<AtiendeWordmarkText fontSize={30} />);
    expect(html).toContain("font-size:30px");
  });
});
