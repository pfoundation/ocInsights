import { describe, expect, test } from "bun:test";
import { ATTRIBUTION_REVISION } from "./metrics/config.ts";
import { CONTRIB_COLS, CONTRIB_SCHEMA, buildPayload } from "./contribute.ts";

function fixture(tship: number): Record<string, unknown> {
  return {
    SESS_COLS: ["day", "role", "child", "model", "prov", "variant", "ocv"],
    CYC_COLS: [
      "sess",
      "i",
      "u",
      "a",
      "tedits",
      "tpaths",
      "teerr",
      "tcost",
      "tship",
      "thrs",
      "tver",
      "tabort",
      "latmed",
      "tshipe",
      "pm",
      "pp",
      "pv",
      "bm",
      "bp",
      "bv",
    ],
    SESS: [["2026-09-01", 2, 0, 0, 0, 0, 0]],
    CYC: [
      [
        0,
        0,
        3,
        5,
        12,
        1,
        0,
        1.5,
        tship,
        0.5,
        1,
        0,
        45.2,
        tship ? 0 : 1,
        0,
        0,
        0,
        0,
        0,
        0,
      ],
    ],
    SESS_KEY: ["abc123"],
    IDX: {
      model: ["test-model"],
      prov: ["test-prov"],
      variant: ["default"],
      ocv: ["1.18"],
    },
    meta: {
      generated: "2026-09-19T00:00:00Z",
      sessions: 1,
      attribution_revision: ATTRIBUTION_REVISION,
    },
  };
}

describe("contribution keys", () => {
  test("schema 3 column list is unchanged", () => {
    expect(CONTRIB_SCHEMA).toBe(3);
    expect(CONTRIB_COLS[CONTRIB_COLS.length - 1]).toBe("hversion");
  });

  test("cycle_key is stable when tship flips", () => {
    const install = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const a = buildPayload(fixture(0), install, "26.9.0");
    const b = buildPayload(fixture(1), install, "26.9.0");
    expect(a.rows[0]![0]).toBe(b.rows[0]![0]);
    expect(a.rows[0]![15]).toBe(0);
    expect(b.rows[0]![15]).toBe(1);
  });
});
