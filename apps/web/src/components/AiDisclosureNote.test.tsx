import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AiDisclosureNote } from "@/components/AiDisclosureNote";

describe("AiDisclosureNote", () => {
  it("muestra un aviso explícito de uso de IA (REQ-115)", () => {
    render(<AiDisclosureNote />);
    expect(screen.getByRole("note", { name: "Aviso de uso de inteligencia artificial" })).toBeInTheDocument();
    expect(screen.getByText(/inteligencia artificial/i)).toBeInTheDocument();
  });
});
