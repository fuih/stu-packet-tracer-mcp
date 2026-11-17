import path from "node:path";

/**
 * Default base directory for generated captures and lab reports.
 * Overridable via the `STU_PT_OUTPUT_DIR` environment variable.
 */
export function getOutputBaseDir(): string {
  const configured = process.env.STU_PT_OUTPUT_DIR?.trim();
  return path.resolve(configured && configured.length > 0 ? configured : "./stu-pt-output");
}

/**
 * Resolve an optional user-supplied `output_path` to an absolute path.
 *
 * - If `outputPath` is absolute, return it normalized.
 * - If `outputPath` is relative, resolve it relative to `getOutputBaseDir()`.
 * - If `outputPath` is omitted, resolve `defaultSubpath` under `getOutputBaseDir()`.
 */
export function resolveOutputPath(outputPath?: string, defaultSubpath = ""): string {
  const base = getOutputBaseDir();
  if (!outputPath || outputPath.trim().length === 0) {
    return defaultSubpath ? path.resolve(base, defaultSubpath) : base;
  }
  const trimmed = outputPath.trim();
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return path.resolve(base, trimmed);
}

/**
 * Turn an arbitrary CLI command or device name into a safe filename slug.
 * Example: "show ip route" -> "show-ip-route"
 */
export function slugify(input: string, maxLen = 48): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug.length > 0 ? slug : "output").slice(0, maxLen);
}
