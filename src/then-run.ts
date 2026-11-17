/** SAFETY: `then_run` fusion — apply the mutation, then run the model's command, as one observation.
 *
 * The markers and their semantics mirror SoL-Pi's pi-side fusion
 * (`src/sol-pi/extensions/action-fusion/then-run.ts`) on purpose: an operator who has both plugins
 * installed reads one vocabulary, whichever definition owns the name.
 */
import {
  createBashToolDefinition,
  type AgentToolUpdateCallback,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { appendOutput, finishJob, startJob } from "./then-run-jobs.js";

const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
/** The ceiling a fused command gets when the call asks for none, in the seconds pi's bash takes —
 *  the repo's own bash ceiling, and the schema default `payload-contract` re-exports. */
export const THEN_RUN_CEILING_SECONDS = 300;

/** Absent, unusable, or over-long gets the ceiling. `payload-contract` normalises the same way at
 *  admission; this covers a call that reaches `execute` without going through it. */
export function normalizeThenRunTimeout(timeout: number | undefined): number {
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : THEN_RUN_CEILING_SECONDS;
}
const THEN_RUN_FAILED = "[then_run:failed]";
const THEN_RUN_SKIPPED = "[then_run:skipped]";

/** A backgrounded run is not a failure: the mutation is applied and the command keeps going. */
const THEN_RUN_BACKGROUNDED = "[then_run:backgrounded]";

/** How long a fused command may hold the observation before the job store takes it over. Mirrors
 *  Pi-Bolt's harness threshold, after which a bare `bash` call moves to the background. */
const THEN_RUN_FOREGROUND_MS = 10_000;
/** Why the command did not run, stated once so every skip reads the same. */
const SKIPPED_REASON = "The mutation did not complete; the command was not run.";

export type ThenRunInput = { command: string; timeout?: number };

/** pi passes the tool context as `ExtensionContext` before 0.99 and `ExtensionToolContext` since — derived so both compile. */
type ToolExecuteContext = Parameters<ToolDefinition["execute"]>[4];

/** The text-block result this seam appends to: pi's `AgentToolResult` as our edit tool returns it. */
interface TextResult {
  content: Array<{ type: "string" | "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textOf(result: TextResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function append(result: TextResult, extra: string, isError: boolean): TextResult {
  const text = textOf(result);
  return {
    ...result,
    content: [{ type: "text", text: text.length > 0 ? `${text}\n${extra}` : extra }],
    details: result.details,
    ...(isError ? { isError: true } : {}),
  };
}

export interface FusedMutationOptions {
  toolCallId: string;
  thenRun: ThenRunInput | undefined;
  mutate: () => Promise<TextResult>;
  signal: AbortSignal | undefined;
  /** pi's own update callback, handed to the command so its output streams while it runs. */
  onUpdate: AgentToolUpdateCallback | undefined;
  /** Foreground window; only tests shorten it, everything else uses THEN_RUN_FOREGROUND_MS. */
  foregroundMs?: number;
  ctx: ToolExecuteContext;
}

/**
 * Mutation first, command second, never the reverse.
 *
 * A refused mutation throws with `[then_run:skipped]` appended and the command is never spawned; a
 * failed command throws with `[then_run:failed]` appended and the mutation stays applied. pi before
 * 0.99 reports a non-zero exit by throwing, later versions by `isError: true` — both are a failure,
 * and both keep the mutation's own output visible.
 *
 * No outer `withFileMutationQueue`: the mutation engine already holds that per-file slot
 * (`src/mutation-queue.ts`), and pi chains per-path promises, so re-acquiring the same path from
 * here would wait for its own release and deadlock.
 */
export async function mutateThenRun(options: FusedMutationOptions): Promise<TextResult> {
  const {
    toolCallId,
    thenRun,
    mutate,
    signal,
    onUpdate,
    ctx,
    foregroundMs = THEN_RUN_FOREGROUND_MS,
  } = options;
  let mutation: TextResult;
  try {
    mutation = await mutate();
  } catch (error) {
    if (thenRun === undefined) throw error;
    throw new Error(`${errorText(error)}\n\n${THEN_RUN_SKIPPED} ${SKIPPED_REASON}`);
  }
  if (thenRun === undefined) return mutation;

  // WHY: the command runs pi's bash definition directly, so it runs even when `bash` is not in the
  // WHY: loadout (same as SoL-Pi's pi side). Ceiling: a loadout without `bash` still spawns the shell;
  // WHY: upgrade by skipping with `[then_run:skipped]` when the active tool set lacks `bash`.
  const bash = createBashToolDefinition((ctx as { cwd?: string }).cwd ?? process.cwd());
  // WHY: pi's bash definition only arms a timer when `timeout` is finite and positive, and calling the
  // WHY: definition directly bypasses the harness rules that cap and background a bare `bash` call.
  // WHY: Left as-is, a command without a timeout runs forever with nothing to read. The ceiling is the
  // WHY: repo's own bash ceiling; the model may ask for a shorter one, never the default's absence.
  const timeout = normalizeThenRunTimeout(thenRun.timeout);

  // WHY: a command longer than the foreground window must not hold the observation hostage. It keeps
  // WHY: running, its streamed output lands in the job record, and the call reports an id the model
  // WHY: can read with `then_run_job`. pi arms its own timeout, so a backgrounded job needs no kill.
  const job = startJob(thenRun.command);
  const run = bash.execute(
    `${toolCallId}:then_run`,
    { ...thenRun, timeout },
    signal,
    (update) => {
      appendOutput(job, textOf(update as TextResult));
      onUpdate?.(update);
    },
    ctx,
  ) as Promise<TextResult>;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    run.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<"backgrounded">((resolve) => {
      timer = setTimeout(() => resolve("backgrounded"), foregroundMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome === "backgrounded") {
    run.then(
      (result) => finishJob(job, textOf(result), result.isError === true ? "failed" : "succeeded"),
      (error) =>
        finishJob(
          job,
          errorText(error),
          errorText(error).startsWith("timeout:") ? "timed out" : "failed",
        ),
    );
    // WHY: a successful result IS recomposed by the `tool_result` hook from `details`, so the notice
    // WHY: goes there (see EditDetails.thenRunTail), never into `content` — that text would be dropped.
    return {
      ...mutation,
      details: {
        ...(mutation.details as object),
        thenRunTail: `${THEN_RUN_BACKGROUNDED} job ${job.id}: ${thenRun.command}`,
      },
    };
  }

  let command: TextResult;
  try {
    command = await run;
  } catch (error) {
    throw new Error(`${textOf(mutation)}\n\n${THEN_RUN_FAILED} ${errorText(error)}`);
  }
  const output = textOf(command);
  const tail = output.length > 0 ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED;
  if (command.isError === true) {
    // WHY: an errored result is not recomposed by the hook, so the tail rides in `content` here.
    return append(
      mutation,
      output.length > 0 ? `${THEN_RUN_FAILED}\n${output}` : THEN_RUN_FAILED,
      true,
    );
  }
  // WHY: a successful result IS recomposed by the `tool_result` hook from `details`, so the tail goes
  // WHY: there (see EditDetails.thenRunTail), never into `content` — that text would be dropped.
  return {
    ...mutation,
    details: { ...(mutation.details as object), thenRunTail: tail },
  };
}
