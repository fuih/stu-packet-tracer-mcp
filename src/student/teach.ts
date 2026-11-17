/**
 * Teach Mode helper (`STU_PT_TEACH_MODE=1` or per-call `dry_run: true`).
 *
 * Off by default. When enabled, configuration and template tools output the
 * exact Cisco IOS commands and step-by-step explanations instead of pushing
 * changes automatically — letting students learn by typing commands themselves.
 */

export function isTeachModeEnabled(dryRun?: boolean): boolean {
  if (typeof dryRun === "boolean") return dryRun;
  return process.env.STU_PT_TEACH_MODE === "1" || process.env.STU_PT_TEACH_MODE === "true";
}

export interface TeachStep {
  readonly device: string;
  readonly summary: string;
  readonly commands: readonly string[];
}

export function formatTeachGuide(title: string, steps: readonly TeachStep[]): string {
  const lines: string[] = [
    `# [Teach Mode — Dry Run] ${title}`,
    "",
    "No changes were applied to Packet Tracer. Follow these steps in the CLI tab of each device:",
    "",
  ];
  for (const step of steps) {
    lines.push(`## ${step.device} — ${step.summary}`);
    lines.push("```ios");
    for (const cmd of step.commands) {
      lines.push(cmd);
    }
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
