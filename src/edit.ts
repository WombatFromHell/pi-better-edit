/** SAFETY: Edit tool — thin adapter over deep EditTool + TuiPresenter.
 *
 * Clean Architecture: this module is the Interface Adapter seam.
 * It owns the pi ToolDefinition wiring only; Use Case lives in EditTool,
 * Framework (pi TUI) lives in TuiPresenter.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  prepareEditArguments,
  EDIT_DESCRIPTION,
  type NormalizedEditRequest,
  type EditItem,
  editToolSchema,
  editItemSchema,
  anchorFromSchema,
  anchorToSchema,
  editFileSchema,
  editModeSchema,
  assertReq,
  CODEMODE_SURFACE,
} from "./payload-contract.js";
import { withPayloadSubject } from "./domain-errors.js";
import { attributePayloadSubject } from "./error-envelope.js";
import { createEditTool, type PreviewContext } from "./edit-tool.js";
import { createTuiPresenter } from "./tui-presenter.js";
import { loadP, loadGuide } from "./prompts.js";
import type { EditDetails } from "./edit-response.js";
import type { RPreview, RRState } from "./edit-render.js";
import { reportWarning } from "./diagnostics.js";
import { mutateThenRun, type ThenRunInput } from "./then-run.js";
void EDIT_DESCRIPTION;
/** SAFETY: @deprecated Import from "./payload-contract.js" — single source per ADR-0007 */
export { assertReq };
/** SAFETY: @deprecated Import from "./payload-contract.js" — single source per ADR-0007. Re-exports retained for compatibility until next MAJOR. `replaceWithSchema` is REMOVED: the ticket-04 wire has no `replace_with` fold. */
export {
  editToolSchema,
  editItemSchema,
  anchorFromSchema,
  anchorToSchema,
  editFileSchema,
  editModeSchema,
};
export { reuseText, reuseMarkdown } from "./tui-presenter.js";

/** The wire item (ticket-04): exactly one payload — `text` or `text_ref` — plus optional `at`. */
export type EditParams = EditItem;

export type EditRequest = NormalizedEditRequest;

export async function compPreview(
  request: unknown,
  cwd: string,
  ctx: PreviewContext,
): Promise<RPreview> {
  const tool = createEditTool();
  return tool.preview(request, cwd, ctx);
}

type ToolDef = ToolDefinition<TSchema, EditDetails, RRState> & {
  renderShell?: "default" | "self";
};

export function buildToolDef(
  getSessionManager?: () => { getSessionId(): string } | undefined,
): ToolDef {
  const E_DESC = loadP("../prompts/edit.md");
  const E_SNIPPET = loadP("../prompts/edit-snippet.md");
  const E_GUIDE = loadGuide("../prompts/edit-guidelines.md");
  const parameters = editToolSchema;
  const tool = createEditTool();
  const presenter = createTuiPresenter(
    // SAFETY: fire-time read is paired with the arm-time getSessionId below; DebouncedPreview
    // SAFETY: drops the compute if the serving session changed between arming and firing.
    (req, cwd) => {
      // SAFETY: the fire-time read stays inside the call so the ctx names the session serving anchors now.
      const sessionManager = getSessionManager?.();
      return tool.preview(req, cwd, sessionManager === undefined ? {} : { sessionManager });
    },
    () => getSessionManager?.()?.getSessionId(),
  );
  return {
    name: "edit",
    label: "Edit",
    description: E_DESC,
    parameters,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDE,
    // WHY: script-reachable under every codemode mode; see CODEMODE_SURFACE in payload-contract.
    ...CODEMODE_SURFACE,
    // WHY: an admission refusal raised here carries no subject, so it must name the edit tool.
    // WHY: Without the stamp the model reads the neutral wording — the analyzer names no caller.
    prepareArguments: (args: unknown) => {
      try {
        return prepareEditArguments(args);
      } catch (error) {
        throw withPayloadSubject(error, "edit");
      }
    },
    renderShell: "default",
    // SAFETY: presenter owns TUI casts — asToolDef returns ToolDefinition-typed renders, edit.ts has zero direct TUI casts
    ...presenter.asToolDef(),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // SAFETY: pi execute boundary is untyped — ctx narrowed via sessionKeyFor, signal is AbortSignal validated by engine
      const record = params as Record<string, unknown>;
      // WHY: `then_run` belongs to the fusion, not the engine: the normalized record keeps the canonical key set.
      const { then_run: thenRun, ...mutation } = record;
      try {
        const res = await mutateThenRun({
          toolCallId,
          thenRun: thenRun as ThenRunInput | undefined,
          mutate: () =>
            tool.execute(
              mutation,
              signal as AbortSignal | undefined,
              // SAFETY: ctx is untyped at the pi boundary — cast validated by pi's runtime shape
              ctx as unknown as {
                cwd: string;
                sessionManager?: { getSessionId(): string };
              },
            ),
          signal: signal as AbortSignal | undefined,
          onUpdate,
          ctx: ctx as unknown as Parameters<ToolDefinition["execute"]>[4],
        });
        // SAFETY: res is validated tool result after the fused run — cast to pi ToolDef return type for registration
        return res as unknown as ReturnType<ToolDef["execute"]> extends Promise<infer R>
          ? R
          : never;
      } catch (error) {
        throw attributePayloadSubject(error, "edit");
      }
    },
  };
}

export function regEdit(pi: ExtensionAPI): void {
  // WHY: (#165) pi's ToolRenderContext carries no session, so the preview pane's session is
  // WHY: captured from the session_start ctx — the same session reads serve anchors to.
  // WHY: session_start fires for startup/reload/new/resume/fork, so the capture tracks switches.
  // WHY: (#168-class) tracking a switch is only safe if the *pending* compute re-checks it:
  // WHY: buildToolDef below exposes getSessionId so DebouncedPreview binds the serving session
  // WHY: at arm time and drops (cancels) a compute whose session changed before the timer fires,
  // WHY: instead of verifying anchors against a session that never served them.
  let sessionManager: { getSessionId(): string } | undefined;
  // WHY: a foreign owner that re-claims the name every run would repeat the notice every run; one
  // WHY: per session is enough to explain the collision, and `session_start` re-arms it on reload/switch.
  let ownershipReported = false;
  pi.on("session_start", (_event, ctx) => {
    sessionManager = ctx.sessionManager;
    ownershipReported = false;
  });
  pi.registerTool(buildToolDef(() => sessionManager));
  // WHY: pi resolves a tool name by the FIRST extension that registered it (runner.getAllRegisteredTools
  // WHY: keeps the first entry per name while walking extensions in load order). A package listed before
  // WHY: us therefore owns `edit` for the whole session, and re-registering from a later handler cannot
  // WHY: displace it: the model holds an exact-text schema while read serves HASH anchors. Ceiling: we
  // WHY: can only report the collision; a real fix needs pi to expose ownership or load order.
  pi.on("before_agent_start", () => {
    const owner = pi.getAllTools().find((tool) => tool.name === "edit");
    if (owner === undefined || declaresHashAnchors(owner)) return;
    if (ownershipReported) return;
    ownershipReported = true;
    reportWarning(
      "tool-ownership",
      `another extension owns edit (${owner.sourceInfo?.path ?? "unknown source"}); pi keeps the first-loaded owner, so list pi-better-edit before it in settings.packages`,
    );
  });
}

/** Structural identity of our own wire: the item declares the bare `anchor_from` anchor. */
function declaresHashAnchors(tool: { parameters?: unknown }): boolean {
  const properties = (
    tool.parameters as
      | { properties?: { edits?: { items?: { properties?: Record<string, unknown> } } } }
      | undefined
  )?.properties;
  return properties?.edits?.items?.properties?.anchor_from !== undefined;
}
