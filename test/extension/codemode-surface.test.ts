import { describe, expect, it } from "vitest";
import register from "../../index";
import { CODEMODE_SURFACE } from "../../src/payload-contract";
import { makeFakePiRegistry } from "../support/fixtures";

/**
 * pi lists a namespace heading with its `description` and hands the longer guidance to
 * `describeNamespace()`, but it never lists a tool's `promptGuidelines` to a codemode script
 * (`docs/codemode.md:50`, `docs/extensions.md:2778`). A script therefore sees the anchor schema with
 * no copy rule, unless the namespace carries it. One surface constant for all three tools keeps the
 * three declarations agreeing instead of three hand-written copies.
 */
describe("codemode surface — hash-anchored tools reachable from scripts", () => {
  const fixture = makeFakePiRegistry();
  register(fixture.pi);

  it("declares exactly the four names and never claims write or codemode", () => {
    expect(fixture.pi.getActiveTools().sort()).toEqual([
      "edit",
      "read",
      "then_run_job",
      "undo_last_edit",
    ]);
    // WHY: these are the names the operator's other packages own — SoL-Pi's fused `write`
    // (`extensions/action-fusion/index.ts:133`) and pi's built-in `codemode`. Claiming either would
    // clobber them, since pi keeps the first extension that registered a name.
    expect(() => fixture.getTool("write")).toThrow();
    expect(() => fixture.getTool("codemode")).toThrow();
    // WHY: `then_run_job` reads job status, not anchors, so it stays outside this namespace and its
    // WHY: instructions — a script sees the anchor contract only for the anchor tools.
    expect(fixture.getTool("then_run_job").namespace).toBeUndefined();
  });

  it("stays callable from scripts under every codemode mode", () => {
    for (const name of ["read", "edit", "undo_last_edit"]) {
      expect(fixture.getTool(name).exposure).toBe("direct");
    }
  });

  it("groups the three tools under one namespace carrying the anchor contract", () => {
    const namespace = fixture.getTool("read").namespace;
    expect(namespace.name).toBe("hashline");
    expect(namespace.aliases).toContain("hash-anchored");
    expect(namespace.description).toContain("read");
    expect(namespace.description).toContain("edit");
    expect(namespace.description).toContain("undo_last_edit");

    const instructions: string = namespace.instructions;
    expect(instructions).toContain("HASH│");
    expect(instructions).toMatch(/anchor_from|anchor_to/);
    expect(instructions).toContain("then_run");
    expect(instructions).toContain("undo_last_edit");
  });

  it("single-sources the surface so the three declarations cannot drift", () => {
    for (const name of ["read", "edit", "undo_last_edit"]) {
      expect(fixture.getTool(name).namespace).toBe(CODEMODE_SURFACE.namespace);
      expect(fixture.getTool(name).exposure).toBe(CODEMODE_SURFACE.exposure);
    }
  });
});
