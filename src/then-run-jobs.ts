/** SAFETY: backgrounded `then_run` commands — id, state, and output, readable by one tool.
 *
 * A fused command that outlives the foreground window is not a failure: the mutation is already
 * applied and the command keeps running. pi's bash definition arms a timeout timer of its own, so a
 * backgrounded job dies at the call's `timeout` (default 300s) and needs no kill path here.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ThenRunJobState = "running" | "succeeded" | "failed" | "timed out";

export interface ThenRunJob {
  id: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  state: ThenRunJobState;
  output: string;
}

/** How many finished jobs a session keeps. Older ones are evicted so a long run cannot grow the store. */
const JOBS_KEPT = 20;
/** Lines of output shown when a job is read; the full stream stays in the job record. */
const OUTPUT_TAIL_LINES = 40;

const jobs = new Map<string, ThenRunJob>();
let counter = 0;

export function startJob(command: string): ThenRunJob {
  counter += 1;
  const job: ThenRunJob = {
    id: `j${counter}`,
    command,
    startedAt: Date.now(),
    state: "running",
    output: "",
  };
  jobs.set(job.id, job);
  for (const [id, kept] of jobs) {
    if (jobs.size <= JOBS_KEPT) break;
    if (kept.state !== "running") jobs.delete(id);
  }
  return job;
}

export function appendOutput(job: ThenRunJob, output: string): void {
  if (job.state === "running") job.output = output;
}

export function finishJob(job: ThenRunJob, output: string, state: ThenRunJobState): void {
  job.output = output;
  job.state = state;
  job.endedAt = Date.now();
}

export function readJob(id: string): ThenRunJob | undefined {
  return jobs.get(id);
}

function listJobs(): ThenRunJob[] {
  return [...jobs.values()];
}

/** Only used by tests, which must not hold a 10-second window. */
export function resetJobs(): void {
  jobs.clear();
  counter = 0;
}

function describeJob(job: ThenRunJob): string {
  const seconds = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const took =
    job.state === "running" ? `${Math.round(seconds)}s, still running` : `${seconds.toFixed(1)}s`;
  const tail =
    job.output.length > 0
      ? job.output.split("\n").slice(-OUTPUT_TAIL_LINES).join("\n")
      : "(no output)";
  return `then_run job ${job.id} [${job.state}] ${took}\n$ ${job.command}\n${tail}`;
}

export function regThenRunJobs(pi: ExtensionAPI): void {
  // WHY: the copy lives here rather than in prompts/: this tool reads status, it carries no anchor
  // WHY: contract, so it has no single-source counterpart in payload-contract to keep in step.
  pi.registerTool({
    name: "then_run_job",
    label: "then_run job",
    description:
      "Read a `then_run` command that was backgrounded: its state, how long it has run, and its output tail. " +
      "Call it with no `id` to list the session's jobs.",
    promptSnippet:
      "Check a backgrounded then_run command: `{ id? }` — absent id lists every job of this session.",
    promptGuidelines: [
      "edit `then_run` reports `[then_run:backgrounded] job <id>` when the command outlives the foreground window; read it with `then_run_job`.",
      "A backgrounded job ends at its own timeout (300s unless the call asked for more); there is no kill.",
    ],
    parameters: Type.Object(
      {
        id: Type.Optional(
          Type.String({ description: 'Job id reported by then_run, e.g. "j3" (absent lists all)' }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { id?: string }) {
      if (params.id !== undefined) {
        const job = readJob(params.id);
        if (job === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `No then_run job ${params.id}. This session keeps the most recent ${JOBS_KEPT} jobs.`,
              },
            ],
            isError: true,
            details: {},
          };
        }
        return { content: [{ type: "text", text: describeJob(job) }], details: {} };
      }
      const all = listJobs();
      return {
        content: [
          {
            type: "text",
            text:
              all.length > 0
                ? all.map(describeJob).join("\n\n")
                : "No then_run jobs in this session.",
          },
        ],
        details: {},
      };
    },
  });
}
