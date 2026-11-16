import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readToolSchema } from "../../src/read";
import { Compile } from "typebox/compile";

const INTEGRATION_DIR = join("src", "integrations", "pi-lens");
const ENTRY = "index.ts";

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function sourceFilesOutsideIntegration(): string[] {
  return walkSources("src").filter((file) => !file.startsWith(`${INTEGRATION_DIR}/`));
}

describe("lens bridge boundary", () => {
  it("keeps every pi-lens reference inside src/integrations/pi-lens", () => {
    // WHY: pi-lens-ignore: suppression markers are not runtime coupling (same standing as
    // WHY: eslint-disable comments) — only real pi-lens references count as offenders.
    const offenders = sourceFilesOutsideIntegration().filter((file) =>
      readFileSync(file, "utf-8")
        .split("\n")
        .some((line) => line.includes("pi-lens") && !line.includes("pi-lens-ignore:")),
    );

    expect(offenders).toEqual([]);
  });

  it("lets only the extension entry point wire the integration dir", () => {
    const importers = sourceFilesOutsideIntegration().filter((file) =>
      /from "[^"]*integrations\/pi-lens/.test(readFileSync(file, "utf-8")),
    );

    expect(importers).toEqual([]);
    expect(readFileSync(ENTRY, "utf-8")).toContain(
      'from "./src/integrations/pi-lens/io-bridge-adapter.js"',
    );
  });

  it("keeps the served-span seam domain-neutral", () => {
    const source = readFileSync("src/served-spans.ts", "utf-8");

    expect(source).not.toContain("integrations");
    expect(source).not.toContain("globalThis");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports).toEqual(['import type { ServedRow } from "./domain-errors.js";']);
  });

  it("keeps the prompts free of the pi-lens token", () => {
    for (const file of ["prompts/read.md", "prompts/read-guidelines.md"]) {
      expect(readFileSync(file, "utf-8"), file).not.toContain("pi-lens");
    }
  });

  it("documents no widening chrome, trigger or caps in this tool's own terms", () => {
    const retiredClaims = [
      "ast symbol",
      "markdown heading",
      "before this tool runs",
      "limit above 100",
      "interop:",
    ];
    for (const file of ["prompts/read.md", "prompts/read-guidelines.md"]) {
      const text = readFileSync(file, "utf-8");
      expect(text, file).not.toContain("widened");
      expect(text, file).not.toContain("24");
      expect(text, file).not.toContain("80");
      expect(text, file).not.toContain("40");
      expect(text, file).not.toContain("(section <extent>)");
      expect(text, file).toContain("verbatim");
      for (const claim of retiredClaims) {
        expect(text.toLowerCase(), `${file} still claims "${claim}"`).not.toContain(claim);
      }
    }
  });

  it("keeps the read payload one flat object the model can emit arguments for", () => {
    // WHY: the wire assertion is on the serialised schema, because that is what the model sees — a
    // WHY: chat template renders the tool verbatim (`tool | tojson`). A top-level `anyOf` carries no
    // WHY: top-level `properties`, and a local llama.cpp/Qwen stack served it verbatim emitted
    // WHY: `arguments: {}` for every `read` call, so the tool was silently unusable. One flat object
    // WHY: is the shape every other tool in the set already has; the per-mode window cap belongs to
    // WHY: admission, which knows the mode (outline ignores caller windows and lifts the cap).
    const wire = JSON.parse(JSON.stringify(readToolSchema)) as {
      type?: string;
      anyOf?: unknown;
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(wire.anyOf).toBeUndefined();
    expect(wire.type).toBe("object");
    expect(wire.required).toEqual(["file"]);
    expect(Object.keys(wire.properties).sort()).toEqual(["file", "mode", "windows"]);

    // WHY: every mode family and the omitted mode validate against the one object — the acceptance
    // WHY: language of the retired two-variant union, minus its top-level shape.
    const validator = Compile(readToolSchema);
    expect(validator.Check({ file: "a.ts" })).toBe(true);
    for (const mode of ["served", "verbatim", "outline"]) {
      expect(validator.Check({ file: "a.ts", mode }), mode).toBe(true);
    }
    expect(validator.Check({ file: "a.ts", windows: [{ offset: 1, limit: 5 }] })).toBe(true);
    expect(validator.Check({ file: "a.ts", windows: [{ around_anchor: "abcd" }] })).toBe(true);
  });

  it("wires the command and the unified adapter from the extension entry point", () => {
    const entry = readFileSync(ENTRY, "utf-8");

    expect(entry).toContain('from "./src/integrations/pi-lens/command.js"');
    expect(entry).toContain('from "./src/integrations/pi-lens/io-bridge-adapter.js"');
    expect(entry).toContain("registerLensCommand(pi)");
    expect(entry).toContain("attachIOBridgeAdapter()");
    expect(entry).not.toContain("attachReadBridgeAdapter");
    expect(entry).not.toContain("attachMutationBridgeAdapter");
  });

  it("keeps the integration surface to the four settled v2 modules", () => {
    expect(walkSources(INTEGRATION_DIR).sort()).toEqual([
      join(INTEGRATION_DIR, "command.ts"),
      join(INTEGRATION_DIR, "config.ts"),
      join(INTEGRATION_DIR, "io-bridge-adapter.ts"),
      join(INTEGRATION_DIR, "io-bridge.ts"),
      join(INTEGRATION_DIR, "settings-overlay.ts"),
    ]);
  });

  it("probes the v2 mount from the command status surface, never the retired v1 keys", () => {
    const command = readFileSync(join(INTEGRATION_DIR, "command.ts"), "utf-8");

    expect(command).toContain('"pi-lens:io-bridge"');
    expect(command).not.toContain('"pi-lens:read-bridge"');
    expect(command).not.toContain('"pi-lens:mutation-bridge"');
  });
});
