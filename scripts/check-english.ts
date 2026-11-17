#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS_TO_CHECK = ["src", "tests", "extension/src"];
const ALLOWLIST_PATH = join(import.meta.dir, "english-allowlist.txt");

const SPANISH_ACCENT_REGEX = /[áéíóúñ¿¡ÁÉÍÓÚÑ]/;
const SPANISH_STOP_WORDS = /\b(el|la|los|las|un|una|unos|unas|de|en|con|para|por|como|que|pero|este|esta|estos|estas)\b/i;

let allowlist: string[] = [];
if (existsSync(ALLOWLIST_PATH)) {
  allowlist = readFileSync(ALLOWLIST_PATH, "utf-8")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"));
}

function shouldSkip(line: string): boolean {
  for (const allowed of allowlist) {
    if (line.includes(allowed)) return true;
  }
  return false;
}

function scanDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...scanDir(fullPath));
    } else if (
      entry.endsWith(".ts") ||
      entry.endsWith(".js") ||
      entry.endsWith(".json") ||
      entry.endsWith(".html") ||
      entry.endsWith(".css")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

interface Violation {
  file: string;
  line: number;
  reason: string;
  snippet: string;
}

const violations: Violation[] = [];

for (const root of ROOTS_TO_CHECK) {
  if (!existsSync(root)) continue;
  const files = scanDir(root);
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (shouldSkip(line)) continue;

      if (SPANISH_ACCENT_REGEX.test(line)) {
        violations.push({
          file,
          line: i + 1,
          reason: "Contains Spanish accented characters",
          snippet: line.trim(),
        });
      } else if (SPANISH_STOP_WORDS.test(line)) {
        // Double check it's not a common English abbreviation or code syntax (e.g. en-US, de-DE, format, etc)
        // Check if the match is inside a comment or string
        const match = line.match(SPANISH_STOP_WORDS);
        if (match) {
          const word = match[0].toLowerCase();
          // Avoid false positives like "de" in "destroy", which regex \b prevents, but standalone "de" might be in some English phrase
          violations.push({
            file,
            line: i + 1,
            reason: `Contains Spanish word "${word}"`,
            snippet: line.trim(),
          });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`\x1b[31m[check-english] Found ${violations.length} non-English violation(s):\x1b[0m\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} - \x1b[33m${v.reason}\x1b[0m`);
    console.error(`    > ${v.snippet}\n`);
  }
  process.exit(1);
} else {
  console.log("\x1b[32m[check-english] Codebase is 100% English clean!\x1b[0m");
  process.exit(0);
}
