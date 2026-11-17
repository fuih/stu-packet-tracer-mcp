import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Bridge } from "../bridge/http-bridge.js";
import { PtError } from "../util/errors.js";
import { errorResult, requireConnectedBridge } from "./helpers.js";
import type { ToolContext, ToolModule } from "./types.js";

export interface StructuredToolReturn {
  readonly text: string;
  readonly structured?: Record<string, unknown>;
  readonly images?: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
  readonly isError?: boolean;
}

export type ToolHandlerReturn =
  | CallToolResult
  | StructuredToolReturn
  | string
  | Record<string, unknown>;

export interface DefineToolOptions<TSchema extends z.ZodObject<z.ZodRawShape>> {
  readonly name: string;
  readonly description: string;
  readonly input: TSchema;
  readonly offline?: boolean;
  readonly category?: string;
  readonly handler: (
    args: z.infer<TSchema>,
    ctx: ToolContext,
  ) => Promise<ToolHandlerReturn> | ToolHandlerReturn;
}

export interface ToolDocEntry {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly offline: boolean;
  readonly category: string;
}

const serverToolRegistry = new WeakMap<McpServer, ToolDocEntry[]>();

export function getRegisteredTools(server: McpServer): readonly ToolDocEntry[] {
  return serverToolRegistry.get(server) ?? [];
}

function recordToolMeta(server: McpServer, entry: ToolDocEntry): void {
  let list = serverToolRegistry.get(server);
  if (!list) {
    list = [];
    serverToolRegistry.set(server, list);
  }
  const idx = list.findIndex(e => e.name === entry.name);
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }
}

function isCallToolResult(val: unknown): val is CallToolResult {
  return (
    typeof val === "object" &&
    val !== null &&
    "content" in val &&
    Array.isArray((val as { content?: unknown }).content)
  );
}

function isStructuredReturn(val: unknown): val is StructuredToolReturn {
  return (
    typeof val === "object" &&
    val !== null &&
    "text" in val &&
    typeof (val as { text?: unknown }).text === "string" &&
    !("content" in val)
  );
}

function normalizeResult(res: ToolHandlerReturn): CallToolResult {
  if (typeof res === "string") {
    return { content: [{ type: "text", text: res }] };
  }
  if (isCallToolResult(res)) {
    return res;
  }
  if (isStructuredReturn(res)) {
    const content: CallToolResult["content"] = [{ type: "text", text: res.text }];
    if (res.images) {
      for (const img of res.images) {
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
    }
    const out: CallToolResult = { content };
    if (res.structured) {
      out.structuredContent = res.structured;
    }
    if (res.isError) {
      out.isError = true;
    }
    return out;
  }
  // Plain object -> emit both JSON text and structuredContent
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    structuredContent: res,
  };
}

function logDuration(toolName: string, startMs: number, ok: boolean): void {
  if (!process.env.STU_PT_DEBUG) return;
  const elapsed = Math.round(performance.now() - startMs);
  console.error(`[stu-pt-mcp] tool ${toolName} ${ok ? "ok" : "err"} (${elapsed}ms)`);
}

/**
 * Define a strict, self-documenting MCP tool module.
 *
 * - Enforces `.strict()` on the Zod input object schema so unknown keys fail clearly.
 * - Checks bridge connectivity automatically unless `offline: true`.
 * - Converts thrown `PtError` and `Error` instances into `isError: true` MCP results.
 * - Attaches `structuredContent` when returning structured data.
 * - Logs execution duration to stderr when `STU_PT_DEBUG=1`.
 */
export function defineTool<TSchema extends z.ZodObject<z.ZodRawShape>>(
  opts: DefineToolOptions<TSchema>,
): ToolModule {
  const strictSchema = opts.input.strict();
  const offline = opts.offline ?? false;
  const category = opts.category ?? "General";

  return (ctx: ToolContext) => {
    recordToolMeta(ctx.server, {
      name: opts.name,
      description: opts.description,
      schema: strictSchema,
      offline,
      category,
    });

    ctx.server.registerTool(
      opts.name,
      {
        description: opts.description,
        inputSchema: strictSchema,
      },
      async (rawArgs: unknown) => {
        const start = performance.now();
        try {
          if (!offline) {
            const blocked = requireConnectedBridge(ctx.bridge);
            if (blocked) {
              logDuration(opts.name, start, false);
              return blocked;
            }
          }
          const parsed = rawArgs as z.infer<TSchema>;
          const out = await opts.handler(parsed, ctx);
          const normalized = normalizeResult(out);
          logDuration(opts.name, start, !normalized.isError);
          return normalized;
        } catch (err) {
          logDuration(opts.name, start, false);
          if (err instanceof PtError) {
            return errorResult(err.format());
          }
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  };
}

/**
 * Upgrade legacy `server.tool(name, description, rawShape, cb)` registrations
 * on an `McpServer` instance so every tool automatically enforces `.strict()`
 * schemas, converts `PtError`s, logs debug durations, and registers metadata
 * for `docs/TOOLS.md` generation.
 */
export function installStrictToolWrapper(server: McpServer, _bridge: Bridge): void {
  const origRegister = server.registerTool.bind(server);

  const wrappedTool = (
    name: string,
    ...rest: unknown[]
  ) => {
    let description = "";
    let rawShape: z.ZodRawShape = {};
    let cb: ((args: unknown, extra: unknown) => Promise<CallToolResult> | CallToolResult) | undefined;

    if (rest.length === 1 && typeof rest[0] === "function") {
      cb = rest[0] as typeof cb;
    } else if (rest.length === 2 && typeof rest[0] === "string" && typeof rest[1] === "function") {
      description = rest[0];
      cb = rest[1] as typeof cb;
    } else if (rest.length === 2 && typeof rest[0] === "object" && typeof rest[1] === "function") {
      rawShape = rest[0] as z.ZodRawShape;
      cb = rest[1] as typeof cb;
    } else if (rest.length >= 3 && typeof rest[0] === "string" && typeof rest[1] === "object" && typeof rest[2] === "function") {
      description = rest[0];
      rawShape = rest[1] as z.ZodRawShape;
      cb = rest[2] as typeof cb;
    } else if (rest.length >= 4 && typeof rest[0] === "string" && typeof rest[1] === "object" && typeof rest[3] === "function") {
      description = rest[0];
      rawShape = rest[1] as z.ZodRawShape;
      cb = rest[3] as typeof cb;
    }

    const strictSchema = z.object(rawShape).strict();

    recordToolMeta(server, {
      name,
      description,
      schema: strictSchema,
      offline: false,
      category: inferCategory(name),
    });

    return origRegister(
      name,
      {
        description,
        inputSchema: strictSchema,
      },
      async (args: unknown, extra: unknown) => {
        const start = performance.now();
        try {
          if (!cb) return errorResult(`Tool ${name} has no handler registered.`);
          const result = await cb(args, extra);
          logDuration(name, start, !result?.isError);
          return result;
        } catch (err) {
          logDuration(name, start, false);
          if (err instanceof PtError) {
            return errorResult(err.format());
          }
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  };

  (server as unknown as { tool: typeof wrappedTool }).tool = wrappedTool;
}

function inferCategory(name: string): string {
  if (name.includes("capture") || name.includes("render_terminal") || name.includes("screenshot")) return "Captures & Visuals";
  if (name.includes("report")) return "Reports";
  if (name.includes("addressing") || name.includes("ping_matrix") || name.includes("check_lab") || name.includes("explain_output") || name.includes("subnet") || name.includes("lab_template")) return "Student Tools";
  if (name.includes("cli") || name.includes("show_running") || name.includes("send_raw")) return "CLI & Diagnostics";
  if (name.includes("ping") || name.includes("traceroute") || name.includes("simulation") || name.includes("pdu")) return "Simulation & Testing";
  if (name.includes("pkt") || name.includes("snapshot")) return "Files & Snapshots";
  if (name.includes("apply_") || name.includes("cook_") || name.includes("mend_") || name.includes("configure_")) return "Configuration & Recipes";
  if (name.includes("bridge") || name.includes("list_") || name.includes("plan_review")) return "Catalog & Status";
  if (name.includes("query_") || name.includes("get_") || name.includes("inspect_") || name.includes("read_") || name.includes("explain_") || name.includes("forecast") || name.includes("generate_") || name.includes("show_")) return "Inspection & Analysis";
  return "Topology & Canvas";
}
