/**
 * Vercel database operations — Phase 0: all actions unsupported.
 * Phase 1: resolve manifest.database.config.urlSecretName → fetch Vercel secret
 *          → inject as DATABASE_URL → generic path handles the rest.
 */
import { err } from "../../core/errors.js";
import type { DatabaseHandler } from "../../tools/db/contracts.js";
import { isVercelManifest } from "./manifest.js";

export const handleVercelDatabaseOps: DatabaseHandler = async (_params, context) => {
  if (!isVercelManifest(context.manifest)) {
    throw err("E_CONFIG_INVALID", "Vercel database handler requires Vercel manifest");
  }
  throw err("E_PHASE_UNSUPPORTED", "V2 database operations are unavailable in Phase 0");
};
