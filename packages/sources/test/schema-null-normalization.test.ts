import { describe, expect, it } from "vitest";
import { z } from "zod";
import { optionalNullish } from "../src/util/schema.js";
import { ComprasMxApiRecordSchema } from "../src/connectors/compras-mx/comprasmx-types.js";
import { mapComprasMxApiRecordToTenderRecord } from "../src/connectors/compras-mx/comprasmx-mapper.js";
import { DofNoticeSchema } from "../src/connectors/dof/dof-types.js";
import { OcdsReleaseSchema } from "../src/connectors/ocds/ocds-types.js";
import { mapOcdsPackageToTenderRecords } from "../src/connectors/ocds/ocds-mapper.js";

describe("optionalNullish (SR-13)", () => {
  it("acepta `null` explícito y lo normaliza a `undefined`, igual que el campo ausente", () => {
    const schema = z.object({ campo: optionalNullish(z.string()) });
    expect(schema.parse({ campo: null })).toEqual({ campo: undefined });
    expect(schema.parse({})).toEqual({ campo: undefined });
    expect(schema.parse({ campo: "valor" })).toEqual({ campo: "valor" });
  });
});

describe("SR-13: ComprasMxApiRecordSchema tolera `null` explícito en cada campo opcional", () => {
  it("un payload con null en TODOS los campos opcionales no lanza ZodError", () => {
    const payload = {
      codigo_expediente: "E-1",
      cod_expediente: null,
      titulo_expediente: "Prueba",
      tipo_expediente: null,
      tipo_contratacion: null,
      entidad_federativa_contratacion: null,
      dependencia_entidad: null,
      unidad_compradora: null,
      caracter: null,
      fecha_publicacion: null,
      fecha_junta_aclaraciones: null,
      fecha_apertura_proposiciones: null,
      fecha_fallo: null,
      monto_estimado: null,
      moneda: null,
      estatus: null,
      id_proceso: null,
    };
    expect(() => ComprasMxApiRecordSchema.parse(payload)).not.toThrow();
    const parsed = ComprasMxApiRecordSchema.parse(payload);
    expect(parsed.tipo_contratacion).toBeUndefined();
  });

  it("mapComprasMxApiRecordToTenderRecord mapea un registro real con null explícito en campos opcionales sin lanzar", () => {
    const record = mapComprasMxApiRecordToTenderRecord(
      {
        codigo_expediente: "E-1",
        titulo_expediente: "Prueba con null",
        dependencia_entidad: null,
        unidad_compradora: null,
        tipo_contratacion: null,
        monto_estimado: null,
        moneda: null,
        estatus: null,
        fecha_publicacion: null,
      },
      { fetchedAt: new Date("2026-01-01T00:00:00Z") },
    );
    expect(record).not.toBeNull();
    expect(record?.contractingEntity).toBe("desconocido");
    expect(record?.currency).toBe("MXN");
    expect(record?.status).toBe("unknown");
  });
});

describe("SR-13: DofNoticeSchema tolera `null` explícito en sus campos opcionales", () => {
  it("no lanza con null en numeroConvocatoria/fechaJuntaAclaraciones/fechaPresentacionApertura/fechaFallo", () => {
    expect(() =>
      DofNoticeSchema.parse({
        codigo: "1",
        fecha: "05/09/2026",
        dependencia: "SECRETARÍA DE PRUEBA",
        titulo: "Prueba",
        numeroConvocatoria: null,
        fechaJuntaAclaraciones: null,
        fechaPresentacionApertura: null,
        fechaFallo: null,
      }),
    ).not.toThrow();
  });
});

describe("SR-13: esquemas OCDS toleran `null` explícito (patrón común de APIs JSON reales)", () => {
  it("OcdsReleaseSchema acepta null en date/tag/parties/tender/awards", () => {
    expect(() =>
      OcdsReleaseSchema.parse({
        ocid: "ocid-1",
        id: "release-1",
        date: null,
        tag: null,
        parties: null,
        buyer: null,
        tender: null,
        awards: null,
      }),
    ).not.toThrow();
  });

  it("mapOcdsPackageToTenderRecords ignora releases sin tender (null) y mapea normalmente el resto con campos null", () => {
    const rawPackage = {
      uri: null,
      version: null,
      publishedDate: null,
      publisher: null,
      license: null,
      releases: [
        { ocid: "ocid-1", id: "release-1", date: null, tender: null },
        {
          ocid: "ocid-2",
          id: "release-2",
          date: "2026-08-01T00:00:00Z",
          buyer: { id: null, name: "Entidad de prueba" },
          tender: {
            id: "tender-2",
            title: "Adquisición de prueba",
            value: { amount: 1000, currency: null },
            tenderPeriod: null,
            items: null,
            documents: null,
          },
        },
      ],
    };

    const records = mapOcdsPackageToTenderRecords(rawPackage, { source: "ocds-shcp", fetchedAt: new Date("2026-08-01T00:00:00Z") });
    expect(records).toHaveLength(1);
    expect(records[0].contractingEntity).toBe("Entidad de prueba");
    expect(records[0].currency).toBe("MXN");
  });
});
