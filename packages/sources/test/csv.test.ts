import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/util/csv.js";

describe("parseCsv (RFC 4180)", () => {
  it("parsea un CSV bien formado con comillas y comas dentro de campos entrecomillados", () => {
    const csv =
      'nombre,descripcion,importe\n' +
      '"Fulano, S.A. de C.V.","Servicio con ""comillas"" internas",1000\n' +
      '"Sutano","Renglón simple",2000\n';
    const { header, rows, errors } = parseCsv(csv);

    expect(header).toEqual(["nombre", "descripcion", "importe"]);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      row: 1,
      values: { nombre: "Fulano, S.A. de C.V.", descripcion: 'Servicio con "comillas" internas', importe: "1000" },
    });
    expect(rows[1].row).toBe(2);
  });

  it("preserva saltos de línea embebidos dentro de un campo entrecomillado", () => {
    const csv = 'titulo,detalle\n"Obra pública","Primera línea\nSegunda línea"\n';
    const { rows, errors } = parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].values.detalle).toBe("Primera línea\nSegunda línea");
  });

  it("rellena con cadena vacía las columnas de MENOS que trae una fila (comportamiento tolerado, no es un error)", () => {
    const csv = "a,b,c\n1,2\n";
    const { rows, errors } = parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ row: 1, values: { a: "1", b: "2", c: "" } }]);
  });

  it("SR-17: una fila con MÁS columnas que el encabezado (coma sin escapar en un campo no entrecomillado) se registra en errors[] en vez de desalinear el resto de la fila", () => {
    const csv = "codigo,proveedor,importe\nE1,Fulano, S.A. de C.V.,1000\n";
    const { rows, errors } = parseCsv(csv);

    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      row: 1,
      message: expect.stringMatching(/columnas/i),
    });
  });

  it("SR-17: una fila con MÁS columnas en medio de filas válidas se descarta explícitamente sin perder las filas válidas alrededor", () => {
    const csv = "codigo,proveedor,importe\nE1,Prov1,1000\nE2,Fulano, S.A. de C.V.,2000\nE3,Prov3,3000\n";
    const { rows, errors } = parseCsv(csv);

    expect(rows.map((r) => r.values.codigo)).toEqual(["E1", "E3"]);
    expect(errors).toEqual([{ row: 2, message: expect.stringMatching(/columnas/i) }]);
  });

  it("ignora la línea en blanco final de un archivo que termina en salto de línea", () => {
    const csv = "a,b\n1,2\n3,4\n";
    const { rows, errors } = parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it("devuelve estructuras vacías para un texto vacío", () => {
    expect(parseCsv("")).toEqual({ header: [], rows: [], errors: [] });
  });
});
