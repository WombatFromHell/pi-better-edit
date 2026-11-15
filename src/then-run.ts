/** SAFETY: `then_run` fusion — apply the mutation, then run the model's command, as one observation.
 *
 * The markers and their semantics mirror SoL-Pi's pi-side fusion
 * (`src/sol-pi/extensions/action-fusion/then-run.ts`) on purpose: an operator who has both plugins
 * installed reads one vocabulary, whichever definition owns the name.
 */
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";
const THEN_RUN_SKIPPED = "[then_run:skipped]";

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
  const { toolCallId, thenRun, mutate, signal, ctx } = options;
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
  let command: TextResult;
  try {
    command = (await bash.execute(
      `${toolCallId}:then_run`,
      thenRun,
      signal,
      undefined,
      ctx,
    )) as TextResult;
  } catch (error) {
    throw new Error(`${textOf(mutation)}\n\n${THEN_RUN_FAILED} ${errorText(error)}`);
  }
  const output = textOf(command);
  if (command.isError === true) {
    return append(
      mutation,
      output.length > 0 ? `${THEN_RUN_FAILED}\n${output}` : THEN_RUN_FAILED,
      true,
    );
  }
  return append(
    mutation,
    output.length > 0 ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED,
    false,
  );
}
