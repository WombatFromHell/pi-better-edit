import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import register from "../../index";
import {
  anchorRows,
  clearDiagnostics,
  extractHash,
  getText,
  makeFakePiRunner,
  readDiagnostics,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

/**
 * A decoy owner for `edit`, registered from its own `session_start` handler — the shape SoL-Pi's
 * action-fusion uses. pi keeps the FIRST extension that registered a name, so loading this decoy
 * before pi-better-edit owns `edit` for the whole session and nothing we register later displaces it.
 */
function registerDecoyEdit(pi: any): void {
  pi.on("session_start", () => {
    pi.registerTool({
      name: "edit",
      label: "Edit",
      description: "decoy exact-text owner",
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
      }),
      async execute() {
        return { content: [{ type: "text", text: "decoy owner ran" }], details: {} };
      },
    });
  });
}

function ctxFor(cwd: string) {
  return { cwd, ui: { notify() {} }, sessionManager: testSessionManager } as any;
}

const ownershipWarnings = () => readDiagnostics().filter((r) => r.scope === "tool-ownership");

describe("edit ownership — pi keeps the first-loaded owner", () => {
  it("reports the collision when another extension claims edit first", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      clearDiagnostics();
      const runner = makeFakePiRunner();
      registerDecoyEdit(runner.load("decoy-extension"));
      register(runner.load("pi-better-edit"));
      const ctx = ctxFor(cwd);

      runner.startSession(ctx);
      runner.runTurn(ctx);

      // The collision as pi resolves it: the decoy stays the active owner, our anchors are unusable.
      const owner = runner.getTool("edit");
      expect(owner.parameters.properties.edits.items.properties["oldText"]).toBeDefined();
      expect(owner.parameters.properties.edits.items.properties["anchor_from"]).toBeUndefined();

      const warnings = ownershipWarnings();
      expect(warnings.length).toBe(1);
      expect(warnings[0].level).toBe("warn");
      expect(warnings[0].message).toContain("decoy-extension");
      expect(warnings[0].message).toContain("settings.packages");

      // Our `read` still serves anchors, which is exactly why the notice must name the remedy.
      const rows = anchorRows(
        getText(
          await runner
            .getTool("read")
            .execute("r1", { file: "sample.txt" }, undefined, undefined, ctx),
        ),
      );
      expect(rows.some((row: string) => row.includes("│bravo"))).toBe(true);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbravo\ncharlie\n");
    });
  });

  it("reports the collision once per session, not once per run", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd }) => {
      clearDiagnostics();
      const runner = makeFakePiRunner();
      registerDecoyEdit(runner.load("decoy-extension"));
      register(runner.load("pi-better-edit"));
      const ctx = ctxFor(cwd);
      runner.startSession(ctx);
      runner.runTurn(ctx);
      runner.runTurn(ctx);
      runner.runTurn(ctx);
      expect(ownershipWarnings().length).toBe(1);
    });
  });

  it("edits with anchors when pi-better-edit loads first", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      clearDiagnostics();
      const runner = makeFakePiRunner();
      register(runner.load("pi-better-edit"));
      registerDecoyEdit(runner.load("decoy-extension"));
      const ctx = ctxFor(cwd);

      runner.startSession(ctx);
      runner.runTurn(ctx);

      const owner = runner.getTool("edit");
      expect(owner.parameters.properties.edits.items.properties["anchor_from"]).toBeDefined();
      expect(ownershipWarnings()).toHaveLength(0);

      const rows = anchorRows(
        getText(
          await runner
            .getTool("read")
            .execute("r1", { file: "sample.txt" }, undefined, undefined, ctx),
        ),
      );
      const anchor = extractHash(rows.find((row: string) => row.includes("│bravo"))!);
      const result = await owner.execute(
        "e1",
        { file: "sample.txt", edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BRAVO" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
    });
  });

  it("leaves the registration alone when nothing else claims edit", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd }) => {
      clearDiagnostics();
      const runner = makeFakePiRunner();
      register(runner.load("pi-better-edit"));
      const ctx = ctxFor(cwd);
      runner.startSession(ctx);
      runner.runTurn(ctx);

      expect(
        runner.getTool("edit").parameters.properties.edits.items.properties["anchor_from"],
      ).toBeDefined();
      expect(ownershipWarnings()).toHaveLength(0);
    });
  });
});
