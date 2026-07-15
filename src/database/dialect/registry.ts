/** Explicit scheme-to-adapter registry. No self-registration side effects. */
import { err } from "../../core/errors.js";
import type { DatabaseTarget } from "../target.js";
import type { DatabaseDialectId, DialectAdapter } from "./contracts.js";

export interface DialectRegistry {
  resolve(target: DatabaseTarget): DialectAdapter;
  supportedSchemes(): readonly string[];
}

export function createDialectRegistry(adapters: readonly DialectAdapter[]): DialectRegistry {
  const byDialect = new Map<DatabaseDialectId, DialectAdapter>();
  const byScheme = new Map<string, DialectAdapter>();

  for (const adapter of adapters) {
    // Check duplicate dialect id
    if (byDialect.has(adapter.id)) {
      throw err("E_CONFIG_INVALID", `duplicate dialect adapter: ${adapter.id}`);
    }
    byDialect.set(adapter.id, adapter);

    // Check duplicate schemes
    for (const scheme of adapter.schemes) {
      const lower = scheme.toLowerCase();
      if (byScheme.has(lower)) {
        throw err("E_CONFIG_INVALID", `duplicate dialect scheme: ${lower}`);
      }
      byScheme.set(lower, adapter);
    }
  }

  return {
    resolve(target: DatabaseTarget): DialectAdapter {
      // For remote targets, resolve by scheme
      if (target.kind === "remote") {
        const scheme = target.url.split("://")[0]?.toLowerCase() ?? "";
        const adapter = byScheme.get(scheme);
        if (!adapter) {
          throw err("E_CONFIG_INVALID", `no dialect adapter for scheme: ${scheme}`);
        }
        return adapter;
      }

      // For local/file targets, resolve by dialect field
      const adapter = byDialect.get(target.dialect);
      if (!adapter) {
        throw err("E_CONFIG_INVALID", `no dialect adapter for dialect: ${target.dialect}`);
      }
      return adapter;
    },

    supportedSchemes(): readonly string[] {
      return [...byScheme.keys()];
    },
  };
}
