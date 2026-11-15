import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import register from "../../index";
import {
  anchorRows,
  clearDiagnostics,
  extractHash,
  getText,
  makeFakePiRegistry,
  readDiagnostics,
  testSessionManager,
  withTempFile,
} from "../support/fixtures";

/**
 * A decoy owner for `edit`, registered from its own `session_start` handler — the shape SoL-Pi's
 * action-fusion uses. pi's registry is a last-write-wins `Map` with no shadow warning, so this
 * decoy owns the name and our hash-anchor definition is displaced while `read` still serves anchors.
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

describe("edit ownership — reclaim from before_agent_start", () => {
  it("reclaims the name when another extension claims edit at session_start", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      clearDiagnostics();
      const { pi, getTool } = makeFakePiRegistry();
      registerDecoyEdit(pi);
      register(pi);
      const ctx = ctxFor(cwd);

      // The collision as it stands today: the later `session_start` registration wins the name.
      pi.startSession(ctx);
      const claimed = getTool("edit").parameters.properties.edits.items.properties;
      expect(claimed["oldText"]).toBeDefined();
      expect(claimed["anchor_from"]).toBeUndefined();

      pi.runTurn(ctx);

      const owned = getTool("edit");
      expect(owned.parameters.properties.edits.items.properties["anchor_from"]).toBeDefined();

      const rows = anchorRows(
        getText(
          await getTool("read").execute("r1", { file: "sample.txt" }, undefined, undefined, ctx),
        ),
      );
      const anchor = extractHash(rows.find((row: string) => row.includes("│bravo"))!);
      const result = await owned.execute(
        "e1",
        { file: "sample.txt", edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BRAVO" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");

      const warnings = readDiagnostics().filter((r) => r.scope === "tool-ownership");
      expect(warnings.length).toBe(1);
      expect(warnings[0].level).toBe("warn");
    });
  });

  it("reports the reclaim once per session, not once per run", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd }) => {
      clearDiagnostics();
      const { pi } = makeFakePiRegistry();
      registerDecoyEdit(pi);
      register(pi);
      const ctx = ctxFor(cwd);
      pi.startSession(ctx);
      pi.runTurn(ctx);
      pi.runTurn(ctx);
      pi.runTurn(ctx);
      expect(readDiagnostics().filter((r) => r.scope === "tool-ownership").length).toBe(1);
    });
  });

  it("leaves the registration alone when we already own edit", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd }) => {
      clearDiagnostics();
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = ctxFor(cwd);
      pi.startSession(ctx);
      pi.runTurn(ctx);

      expect(
        getTool("edit").parameters.properties.edits.items.properties["anchor_from"],
      ).toBeDefined();
      expect(readDiagnostics().filter((r) => r.scope === "tool-ownership")).toHaveLength(0);
    });
  });
});
