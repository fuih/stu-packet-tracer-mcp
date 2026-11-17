export type ThemeName = "pt-classic" | "dark" | "putty" | "high-contrast" | "pc-cmd";

export const THEME_NAMES: readonly ThemeName[] = [
  "pt-classic",
  "dark",
  "putty",
  "high-contrast",
  "pc-cmd",
] as const;

export interface TerminalTheme {
  readonly name: ThemeName;
  readonly background: string;
  readonly text: string;
  readonly border: string;
  readonly chromeBg: string;
  readonly chromeText: string;
  readonly chromeBorder: string;
  readonly chromeStyle: "pt-tabs" | "macos" | "windows" | "print" | "cmd";
  readonly promptColor: string;
  readonly successColor: string;
  readonly errorColor: string;
  readonly accentColor: string;
  readonly mutedColor: string;
  readonly annotationBg: string;
  readonly annotationText: string;
  readonly annotationBorder: string;
}

export const THEMES: Readonly<Record<ThemeName, TerminalTheme>> = {
  "pt-classic": {
    name: "pt-classic",
    background: "#FFFFFF",
    text: "#111111",
    border: "#B8C0CC",
    chromeBg: "#E6EAF0",
    chromeText: "#1F2937",
    chromeBorder: "#C5CDD8",
    chromeStyle: "pt-tabs",
    promptColor: "#0F172A",
    successColor: "#15803D",
    errorColor: "#B91C1C",
    accentColor: "#1D4ED8",
    mutedColor: "#64748B",
    annotationBg: "#EFF6FF",
    annotationText: "#1E40AF",
    annotationBorder: "#93C5FD",
  },
  dark: {
    name: "dark",
    background: "#0C0C0C",
    text: "#D4D4D4",
    border: "#2D2D2D",
    chromeBg: "#1F242D",
    chromeText: "#E5E7EB",
    chromeBorder: "#30363D",
    chromeStyle: "macos",
    promptColor: "#4ADE80",
    successColor: "#4ADE80",
    errorColor: "#F87171",
    accentColor: "#60A5FA",
    mutedColor: "#737373",
    annotationBg: "#1E293B",
    annotationText: "#93C5FD",
    annotationBorder: "#3B82F6",
  },
  putty: {
    name: "putty",
    background: "#000000",
    text: "#C0C0C0",
    border: "#1F3B6D",
    chromeBg: "#1F4E8C",
    chromeText: "#FFFFFF",
    chromeBorder: "#143561",
    chromeStyle: "windows",
    promptColor: "#00FF00",
    successColor: "#00DD00",
    errorColor: "#FF5555",
    accentColor: "#55AAFF",
    mutedColor: "#808080",
    annotationBg: "#111827",
    annotationText: "#93C5FD",
    annotationBorder: "#3B82F6",
  },
  "high-contrast": {
    name: "high-contrast",
    background: "#FFFFFF",
    text: "#000000",
    border: "#000000",
    chromeBg: "#FFFFFF",
    chromeText: "#000000",
    chromeBorder: "#000000",
    chromeStyle: "print",
    promptColor: "#000000",
    successColor: "#000000",
    errorColor: "#000000",
    accentColor: "#000000",
    mutedColor: "#000000",
    annotationBg: "#FFFFFF",
    annotationText: "#000000",
    annotationBorder: "#000000",
  },
  "pc-cmd": {
    name: "pc-cmd",
    background: "#0C0C0C",
    text: "#CCCCCC",
    border: "#3A3A3A",
    chromeBg: "#1F1F1F",
    chromeText: "#F3F4F6",
    chromeBorder: "#3A3A3A",
    chromeStyle: "cmd",
    promptColor: "#FFFFFF",
    successColor: "#4ADE80",
    errorColor: "#F87171",
    accentColor: "#38BDF8",
    mutedColor: "#888888",
    annotationBg: "#1E293B",
    annotationText: "#93C5FD",
    annotationBorder: "#3B82F6",
  },
};

export function getTheme(name: ThemeName = "pt-classic"): TerminalTheme {
  return THEMES[name] ?? THEMES["pt-classic"];
}
