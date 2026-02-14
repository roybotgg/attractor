/**
 * Tests for CXDB type registry.
 */

import { describe, test, expect } from "bun:test";
import { TypeIds, TypeVersions } from "../../src/cxdb/types.js";

describe("CXDB Type Registry", () => {
  test("all type IDs follow reverse-DNS convention", () => {
    for (const [_key, typeId] of Object.entries(TypeIds)) {
      expect(typeId).toMatch(/^attractor\./);
    }
  });

  test("all type IDs have a version defined", () => {
    for (const [_key, typeId] of Object.entries(TypeIds)) {
      expect(TypeVersions[typeId]).toBeGreaterThan(0);
    }
  });

  test("expected type IDs exist", () => {
    expect(TypeIds.PIPELINE_RUN).toBe("attractor.pipeline.run");
    expect(TypeIds.STAGE_RESULT).toBe("attractor.stage.result");
    expect(TypeIds.CHECKPOINT).toBe("attractor.pipeline.checkpoint");
    expect(TypeIds.STAGE_LOG).toBe("attractor.stage.log");
  });

  test("all versions are v1", () => {
    // On initial release, all types should be v1
    for (const [_typeId, version] of Object.entries(TypeVersions)) {
      expect(version).toBe(1);
    }
  });
});
