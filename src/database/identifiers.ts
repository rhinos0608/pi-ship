/** PostgreSQL identifier quoting. No string interpolation of user values. */
import { err } from "../core/errors.js";

/**
 * Quote a PostgreSQL identifier (schema, table, column, filter, order).
 * Rejects empty, NUL character, or UTF-8 byte length >63.
 * Doubles embedded double-quote characters.
 */
export function quoteIdentifier(value: string): string {
  if (typeof value !== "string") {
    throw err("E_CONFIG_INVALID", "identifier must be a string");
  }
  if (value.length === 0) {
    throw err("E_CONFIG_INVALID", "identifier must not be empty");
  }
  if (value.includes("\0")) {
    throw err("E_CONFIG_INVALID", "identifier must not contain NUL character");
  }
  if (Buffer.byteLength(value, "utf8") > 63) {
    throw err("E_CONFIG_INVALID", "identifier UTF-8 byte length exceeds 63");
  }
  return `"${value.replace(/"/g, '""')}"`;
}
