import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  anchorRows,
  extractHash,
  getText,
  setupIntegrationTest,
  withTempFile,
} from "../support/fixtures";
import { finalizeToolResult } from "../../src/edit-response.js";

/** Anchor of the line containing `needle`, taken from a fresh serve — the same lease a model uses. */
async function anchorOf(readTool: any, ctx: any, file: string, needle: string): Promise<string> {
  const rows = anchorRows(
    getText(await readTool.execute("r1", { file }, undefined, undefined, ctx)),
  );
  return extractHash(rows.find((row: string) => row.includes(`│${needle}`))!);
}

describe("edit — then_run fusion", () => {
  it("leaves the result untouched when no command is asked for", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = await anchorOf(readTool, ctx, "sample.txt", "bravo");

      const result = await editTool.execute(
        "e1",
        { file: "sample.txt", edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BRAVO" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(getText(result)).toContain("Successfully edited");
      expect(getText(result)).not.toContain("[then_run");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
    });
  });

  it("runs the command after the mutation and reports success in one observation", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = await anchorOf(readTool, ctx, "sample.txt", "bravo");

      const result = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BRAVO" }],
          then_run: { command: "grep -c BRAVO sample.txt" },
        },
        undefined,
        undefined,
        ctx,
      );

      // WHY: the `tool_result` hook recomposes the model-visible text from `details`, so the tail must
      // WHY: live in `details` — text appended to `content` here would be silently dropped in pi.
      const composed = finalizeToolResult(result.details as any);
      expect(composed.content[0].text).toContain("Successfully edited");
      expect(composed.content[0].text).toContain("[then_run:succeeded]");
      expect(composed.content[0].text).toContain("1");
      expect(getText(result)).not.toContain("[then_run");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
    });
  });

  it("keeps the mutation and reports failure when the command fails", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = await anchorOf(readTool, ctx, "sample.txt", "bravo");

      await expect(
        editTool.execute(
          "e1",
          {
            file: "sample.txt",
            edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BRAVO" }],
            then_run: { command: "exit 3" },
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/\[then_run:failed\]/);

      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
    });
  });

  it("never runs the command when the mutation is refused", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const marker = join(cwd, "ran.marker");

      const failure = await editTool
        .execute(
          "e1",
          {
            file: "sample.txt",
            edits: [{ anchor_from: "zzzz", anchor_to: "zzzz", text: "BRAVO" }],
            then_run: { command: "touch ran.marker" },
          },
          undefined,
          undefined,
          ctx,
        )
        .then(() => undefined)
        .catch((error: unknown) => error as Error);

      expect(failure?.message).toMatch(/\[E_[A-Z_]+]/);
      expect(failure?.message).toContain("[then_run:skipped]");
      expect(existsSync(marker)).toBe(false);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbravo\ncharlie\n");
    });
  });
});
