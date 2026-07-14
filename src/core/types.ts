import type { Static } from "typebox";

export type Environment = "development" | "preview" | "production";
export type Provider = "railway";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export type { Static };
