import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  anchorRows,
  extractHash,
  makeFakePiRegistry,
  getText,
  setupIntegrationTest,
  withTempFile,
} from "../support/fixtures";
import { finalizeToolResult } from "../../src/edit-response.js";
import { readJob, regThenRunJobs, resetJobs } from "../../src/then-run-jobs.js";
import { mutateThenRun } from "../../src/then-run.js";
import {
  DEFAULT_THEN_RUN_TIMEOUT_SECONDS,
  prepareEditArguments,
} from "../../src/payload-contract.js";

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

describe("edit — then_run timeout ceiling", () => {
  /** Admission only: anchors are shape-checked here, never resolved against a file.
   *  WHY: the ceiling is a contract decision, so it is pinned without a clock or a temp file.
   */
  function prepared(thenRun: unknown): { then_run?: { command: string; timeout?: number } } {
    return prepareEditArguments({
      file: "sample.txt",
      edits: [{ anchor_from: "aaaa", anchor_to: "aaaa", text: "BRAVO" }],
      then_run: thenRun,
    }) as { then_run?: { command: string; timeout?: number } };
  }

  it("defaults an omitted timeout to the ceiling and honors an explicit one", () => {
    expect(prepared({ command: "pnpm test" }).then_run?.timeout).toBe(
      DEFAULT_THEN_RUN_TIMEOUT_SECONDS,
    );
    expect(prepared({ command: "pnpm test", timeout: null }).then_run?.timeout).toBe(
      DEFAULT_THEN_RUN_TIMEOUT_SECONDS,
    );
    // WHY: pi rejects 0 and non-finite timeouts AFTER the mutation lands, which reports a failed
    // WHY: command for a run that never started; the ceiling folds them instead.
    for (const invalid of [0, -5, Number.NaN]) {
      expect(prepared({ command: "pnpm test", timeout: invalid }).then_run?.timeout).toBe(
        DEFAULT_THEN_RUN_TIMEOUT_SECONDS,
      );
    }
    expect(prepared({ command: "pnpm test", timeout: 120 }).then_run?.timeout).toBe(120);
  });

  it("stops a command that never exits at its timeout and keeps the mutation applied", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = await anchorOf(readTool, ctx, "sample.txt", "bravo");

      const failure = await editTool
        .execute(
          "e1",
          {
            file: "sample.txt",
            edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BRAVO" }],
            then_run: { command: "sleep 30", timeout: 1 },
          },
          undefined,
          undefined,
          ctx,
        )
        .then(() => undefined)
        .catch((error: unknown) => error as Error);

      expect(failure?.message).toContain("[then_run:failed]");
      expect(failure?.message).toContain("timed out after 1 seconds");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
    });
  });
});

describe("edit — then_run output streamed", () => {
  it("reports the running command's output through the update callback", async () => {
    await withTempFile("sample.txt", "alpha\nbravo\ncharlie\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchor = await anchorOf(readTool, ctx, "sample.txt", "bravo");

      const updates: Array<{ content?: Array<{ text?: string }> }> = [];
      const result = await editTool.execute(
        "e1",
        {
          file: "sample.txt",
          edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BRAVO" }],
          then_run: { command: "echo hello" },
        },
        undefined,
        (update: { content?: Array<{ text?: string }> }) => updates.push(update),
        ctx,
      );

      // WHY: pi's bash definition only streams when it is handed an update callback; without one the
      // WHY: TUI has nothing to show while the fused command runs.
      expect(updates.some((u) => (u.content?.[0]?.text ?? "").includes("hello"))).toBe(true);
      const composed = finalizeToolResult(result.details as any);
      expect(composed.content[0].text).toContain("[then_run:succeeded]");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBRAVO\ncharlie\n");
    });
  });
});

describe("edit — then_run background handoff", () => {
  it("hands a command longer than the foreground window to the job store", async () => {
    resetJobs();
    const result = await mutateThenRun({
      toolCallId: "bg",
      thenRun: { command: "sleep 1; echo later" },
      // SAFETY: the seam's foreground window is shortened so the test never holds a real 10s run
      foregroundMs: 30,
      signal: new AbortController().signal,
      onUpdate: undefined,
      ctx: setupIntegrationTest(process.cwd()).ctx,
      mutate: async () => ({
        content: [{ type: "text" as const, text: "Mutation applied." }],
        details: {},
      }),
    });

    const details = result.details as { thenRunTail: string };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Mutation applied.");
    expect(details.thenRunTail).toMatch(
      /^\[then_run:backgrounded\] job j\d+: sleep 1; echo later$/,
    );
    const id = idOf(details.thenRunTail);
    await vi.waitFor(() => expect(readJob(id)?.state).toBe("succeeded"), { timeout: 3000 });
    expect(readJob(id)?.output).toContain("later");
  });

  it("reads a job back through then_run_job", async () => {
    resetJobs();
    const { pi, getTool } = makeFakePiRegistry();
    regThenRunJobs(pi);
    const jobTool = getTool("then_run_job");

    expect(getText(await jobTool.execute("t1", {}, undefined, undefined, {} as any))).toContain(
      "No then_run jobs in this session.",
    );
    const missing = await jobTool.execute("t2", { id: "j9" }, undefined, undefined, {} as any);
    expect(missing.isError).toBe(true);
    expect(getText(missing)).toContain("No then_run job j9");
  });
});

/** The id the notice carries, so the test never pins a counter value. */
function idOf(tail: string): string {
  return tail.match(/job (j\d+)/)![1];
}
