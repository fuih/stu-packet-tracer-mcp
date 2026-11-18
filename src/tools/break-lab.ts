import { z } from "zod";
import { breakLabLive } from "../student/break-lab.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  count: z.number().int().min(1).max(5).default(2).describe("Number of realistic faults to inject (1 to 5)."),
  difficulty: z.enum(["easy", "medium", "hard"]).default("medium").describe(
    "Difficulty level: 'easy' (shutdown port, wrong gateway), 'medium' (classful mask trap, wrong LAN subnet), or 'hard' (self next-hop static route, WAN mask mismatch).",
  ),
  reveal_solutions: z.boolean().default(false).describe(
    "Set true to include the answer key and exact restore commands; defaults to false so students get spoiler-free practice tickets.",
  ),
  dry_run: z.boolean().default(false).describe(
    "Preview planned fault tickets without modifying Packet Tracer.",
  ),
  seed: z.number().int().optional().describe("Optional random seed for repeatable challenge generation."),
});

export const registerBreakLabTool = defineTool({
  name: "pt_break_lab",
  description: "Turn any working Packet Tracer topology into a hands-on troubleshooting challenge by injecting 1–5 realistic networking faults (shutdown links, wrong gateways, classful /8 masks, broken static routes, WAN mismatches). Returns spoiler-free trouble tickets for student practice or CCNA exam prep.",
  category: "Student Tools",
  input: InputSchema,
  handler: async ({ count, difficulty, reveal_solutions, dry_run, seed }, { bridge }) => {
    const res = await breakLabLive(bridge, {
      count,
      difficulty,
      revealSolutions: reveal_solutions,
      dryRun: dry_run,
      seed,
    });

    return {
      text: res.markdown,
      structured: {
        difficulty: res.difficulty,
        faultsPlanned: res.faultsPlanned,
        faultsInjected: res.faultsInjected,
        dryRun: res.dryRun,
        revealSolutions: res.revealSolutions,
        faults: res.revealSolutions
          ? res.faults
          : res.faults.map(f => ({
              id: f.id,
              difficulty: f.difficulty,
              studentSymptom: f.studentSymptom,
            })),
      },
    };
  },
});
