import type { ThemeName } from "../render/themes.js";
import type { AddressingRow } from "../student/addressing.js";
import type { PingMatrixResult } from "../student/ping-matrix.js";

export interface ReportStudent {
  readonly name?: string;
  readonly group?: string;
  readonly id?: string;
}

export interface ReportCaptureItem {
  readonly label: string;
  readonly device: string;
  readonly command: string;
  readonly text: string;
  readonly svg?: string;
  readonly svgPath?: string;
  readonly pngPath?: string;
  readonly pngBytes?: Uint8Array;
  readonly pngWidth?: number;
  readonly pngHeight?: number;
}

export interface ReportSectionData {
  readonly heading: string;
  readonly text?: string;
  readonly captures: readonly ReportCaptureItem[];
}

export interface ReportTopologyImage {
  readonly pngPath: string;
  readonly pngBytes: Uint8Array;
  readonly width?: number;
  readonly height?: number;
}

export interface ReportPingMatrixData {
  readonly result: PingMatrixResult;
  readonly svg?: string;
  readonly svgPath?: string;
  readonly pngPath?: string;
  readonly pngBytes?: Uint8Array;
  readonly pngWidth?: number;
  readonly pngHeight?: number;
}

export interface LabReport {
  readonly title: string;
  readonly course?: string;
  readonly student?: ReportStudent;
  readonly generatedAt: string;
  readonly outputDir: string;
  readonly topology?: ReportTopologyImage;
  readonly addressing?: readonly AddressingRow[];
  readonly pingMatrix?: ReportPingMatrixData;
  readonly sections: readonly ReportSectionData[];
  readonly savedPktPath?: string;
}

export interface ReportTroubleshootingStep {
  readonly fault: string;
  readonly root_cause?: string;
  readonly before_capture?: {
    readonly device: string;
    readonly command: string;
    readonly kind?: "ios" | "pc";
    readonly theme?: ThemeName;
  };
  readonly fix_cli?: {
    readonly device: string;
    readonly commands: readonly string[];
  };
  readonly fix_pc?: {
    readonly device: string;
    readonly port?: string;
    readonly ip: string;
    readonly mask: string;
    readonly gateway?: string;
  };
  readonly after_capture?: {
    readonly device: string;
    readonly command: string;
    readonly kind?: "ios" | "pc";
    readonly theme?: ThemeName;
  };
}

export interface ReportSectionInput {
  readonly heading: string;
  readonly text?: string;
  readonly captures?: ReadonlyArray<{
    readonly device: string;
    readonly commands: readonly string[];
    readonly theme?: ThemeName;
  }>;
  readonly pc_captures?: ReadonlyArray<{
    readonly device: string;
    readonly command: string;
    readonly theme?: ThemeName;
  }>;
  readonly troubleshooting?: readonly ReportTroubleshootingStep[];
}
