import { describe, expect, it } from "vitest";
import {
  createPolicy,
  DEFAULT_POLICY,
  spotlight,
  spotlightValue,
  spotlightingPreamble,
  defendToolResult,
  type SpotlightingPolicy,
} from "../../src/defense/spotlight.js";
import type { ToolResult } from "../../src/core/types.js";

describe("createPolicy", () => {
  it("generates unique delimiter tokens per call", () => {
    const a = createPolicy(1);
    const b = createPolicy(1);
    expect(a.startDelimiter).not.toBe(b.startDelimiter);
    expect(a.endDelimiter).not.toBe(b.endDelimiter);
  });

describe("defendToolResult", () => {
  const makeResult = (overrides?: Partial<ToolResult>): ToolResult => ({
    content: [{ type: "text", text: "Query returned 3 rows" }],
    details: { rows: [{ name: "Alice", email: "alice@evil.com" }], rowCount: 3 },
    ...overrides,
  });

  it("prepends preamble as first content entry", () => {
    const result = defendToolResult(makeResult());
    expect(result.content.length).toBe(2);
    expect(result.content[0].text).toContain("SPOTLIGHT DEFENSE");
    expect(result.content[0].text).toContain("UNTRUSTED external data");
  });

  it("wraps original content text in delimiters", () => {
    const policy = createPolicy(1);
    const result = defendToolResult(makeResult(), policy);
    expect(result.content[1].text).toBe(
      `${policy.startDelimiter}Query returned 3 rows${policy.endDelimiter}`,
    );
  });

  it("spotlights detail leaf strings", () => {
    const policy = createPolicy(1);
    const result = defendToolResult(makeResult(), policy);
    const rows = result.details.rows as Array<Record<string, unknown>>;
    expect(rows[0].name).toBe(
      `${policy.startDelimiter}Alice${policy.endDelimiter}`,
    );
    expect(rows[0].email).toBe(
      `${policy.startDelimiter}alice@evil.com${policy.endDelimiter}`,
    );
  });

  it("preserves non-string detail values", () => {
    const result = defendToolResult(makeResult());
    expect(result.details.rowCount).toBe(3);
  });

  it("handles multiple content entries", () => {
    const result = defendToolResult({
      content: [
        { type: "text", text: "Status: READY" },
        { type: "text", text: "URL: https://example.com" },
      ],
      details: {},
    });
    expect(result.content.length).toBe(3); // preamble + 2
    expect(result.content[1].text).toContain("Status: READY");
    expect(result.content[2].text).toContain("URL: https://example.com");
  });

  it("handles empty details", () => {
    const result = defendToolResult({
      content: [{ type: "text", text: "ok" }],
      details: {},
    });
    expect(result.details).toEqual({});
  });

  it("uses DEFAULT_POLICY when no policy given", () => {
    const result = defendToolResult(makeResult());
    expect(result.content[0].text).toContain("v1");
  });
});

  it("produces delimiters in expected format", () => {
    const policy = createPolicy(2);
    expect(policy.startDelimiter).toMatch(/^<<<UNTRUSTED:[a-f0-9-]+>>>$/);
    expect(policy.endDelimiter).toMatch(/^<<<END_UNTRUSTED:[a-f0-9-]+>>>$/);
  });

  it("pairs start and end tokens", () => {
    const policy = createPolicy(1);
    const startToken = policy.startDelimiter.slice(
      "<<<UNTRUSTED:".length,
      -">>>".length,
    );
    const endToken = policy.endDelimiter.slice(
      "<<<END_UNTRUSTED:".length,
      -">>>".length,
    );
    expect(startToken).toBe(endToken);
  });

  it("stores version", () => {
    expect(createPolicy(1).version).toBe(1);
    expect(createPolicy(5).version).toBe(5);
  });
});

describe("DEFAULT_POLICY", () => {
  it("is version 1", () => {
    expect(DEFAULT_POLICY.version).toBe(1);
  });

  it("is a valid policy", () => {
    expect(DEFAULT_POLICY.startDelimiter).toMatch(
      /^<<<UNTRUSTED:[a-f0-9-]+>>>$/,
    );
    expect(DEFAULT_POLICY.endDelimiter).toMatch(
      /^<<<END_UNTRUSTED:[a-f0-9-]+>>>$/,
    );
  });
});

describe("spotlight", () => {
  it("wraps text in delimiters", () => {
    const policy = createPolicy(1);
    const { wrapped } = spotlight("hello", policy);
    expect(wrapped).toBe(
      `${policy.startDelimiter}hello${policy.endDelimiter}`,
    );
  });

  it("returns delimiter field matching start delimiter", () => {
    const policy = createPolicy(1);
    const { delimiter } = spotlight("hello", policy);
    expect(delimiter).toBe(policy.startDelimiter);
  });

  it("uses DEFAULT_POLICY when no policy given", () => {
    const { wrapped } = spotlight("test");
    expect(wrapped.startsWith(DEFAULT_POLICY.startDelimiter)).toBe(true);
    expect(wrapped.endsWith(DEFAULT_POLICY.endDelimiter)).toBe(true);
    expect(wrapped).toContain("test");
  });

  it("handles empty string", () => {
    const policy = createPolicy(1);
    const { wrapped } = spotlight("", policy);
    expect(wrapped).toBe(`${policy.startDelimiter}${policy.endDelimiter}`);
  });

  it("handles string with special characters", () => {
    const policy = createPolicy(1);
    const input = "DROP TABLE users;-- ' OR 1=1 --";
    const { wrapped } = spotlight(input, policy);
    expect(wrapped).toContain(input);
    expect(wrapped).toBe(`${policy.startDelimiter}${input}${policy.endDelimiter}`);
  });

  it("handles multiline text", () => {
    const policy = createPolicy(1);
    const input = "line1\nline2\nline3";
    const { wrapped } = spotlight(input, policy);
    expect(wrapped).toBe(`${policy.startDelimiter}${input}${policy.endDelimiter}`);
  });

  it("delimiter does not appear as substring inside random text (no collision)", () => {
    // With 100 random text strings, the randomUUID token should never appear
    // naturally inside the input, so the only delimiter occurrences are the
    // opening and closing markers.
    for (let i = 0; i < 100; i++) {
      const policy = createPolicy(1);
      const input = `random user data row ${i}: some injected text here`;
      const { wrapped } = spotlight(input, policy);
      // The start delimiter appears exactly once (opening marker)
      const firstIdx = wrapped.indexOf(policy.startDelimiter);
      const lastIdx = wrapped.lastIndexOf(policy.startDelimiter);
      expect(firstIdx).toBe(0);
      expect(lastIdx).toBe(0);
      // The end delimiter appears exactly once (closing marker)
      expect(wrapped.indexOf(policy.endDelimiter)).toBe(
        wrapped.length - policy.endDelimiter.length,
      );
    }
  });

  it("handles input containing delimiter-like text gracefully", () => {
    // When external data happens to contain the delimiter string, the
    // wrapping still completes without error (the semantic boundary is
    // ambiguous, but the text is still wrapped).
    const policy = createPolicy(1);
    const input = `some <<<UNTRUSTED:fake>>> text`;
    const { wrapped } = spotlight(input, policy);
    expect(wrapped.startsWith(policy.startDelimiter)).toBe(true);
    expect(wrapped.endsWith(policy.endDelimiter)).toBe(true);
    expect(wrapped).toContain(input);
  });
});

describe("spotlightValue", () => {
  it("wraps plain string", () => {
    const policy = createPolicy(1);
    const result = spotlightValue("hello", policy) as string;
    expect(result).toBe(`${policy.startDelimiter}hello${policy.endDelimiter}`);
  });

  it("passes through numbers", () => {
    expect(spotlightValue(42)).toBe(42);
    expect(spotlightValue(0)).toBe(0);
    expect(spotlightValue(-1)).toBe(-1);
    expect(spotlightValue(3.14)).toBe(3.14);
  });

  it("passes through booleans", () => {
    expect(spotlightValue(true)).toBe(true);
    expect(spotlightValue(false)).toBe(false);
  });

  it("passes through null", () => {
    expect(spotlightValue(null)).toBeNull();
  });

  it("wraps all leaf strings in flat object", () => {
    const policy = createPolicy(1);
    const input = { name: "Alice", role: "admin", age: 30 };
    const result = spotlightValue(input, policy) as Record<string, unknown>;
    expect(result.name).toBe(
      `${policy.startDelimiter}Alice${policy.endDelimiter}`,
    );
    expect(result.role).toBe(
      `${policy.startDelimiter}admin${policy.endDelimiter}`,
    );
    expect(result.age).toBe(30);
  });

  it("wraps strings in array", () => {
    const policy = createPolicy(1);
    const input = ["a", "b", "c"];
    const result = spotlightValue(input, policy) as string[];
    expect(result[0]).toBe(`${policy.startDelimiter}a${policy.endDelimiter}`);
    expect(result[1]).toBe(`${policy.startDelimiter}b${policy.endDelimiter}`);
    expect(result[2]).toBe(`${policy.startDelimiter}c${policy.endDelimiter}`);
  });

  it("preserves non-string elements in array", () => {
    const policy = createPolicy(1);
    const input = ["text", 42, true, null];
    const result = spotlightValue(input, policy) as unknown[];
    expect(result[0]).toBe(`${policy.startDelimiter}text${policy.endDelimiter}`);
    expect(result[1]).toBe(42);
    expect(result[2]).toBe(true);
    expect(result[3]).toBeNull();
  });

  it("recurses into nested objects", () => {
    const policy = createPolicy(1);
    const input = {
      meta: { description: "nested data", count: 5 },
      tags: ["urgent", "critical"],
    };
    const result = spotlightValue(input, policy) as Record<string, unknown>;
    const meta = result.meta as Record<string, unknown>;
    expect(meta.description).toBe(
      `${policy.startDelimiter}nested data${policy.endDelimiter}`,
    );
    expect(meta.count).toBe(5);
  });

  it("recurses into nested arrays", () => {
    const policy = createPolicy(1);
    const input = [["deep", "strings"], [1, 2]];
    const result = spotlightValue(input, policy) as unknown[][];
    expect(result[0][0]).toBe(
      `${policy.startDelimiter}deep${policy.endDelimiter}`,
    );
    expect(result[0][1]).toBe(
      `${policy.startDelimiter}strings${policy.endDelimiter}`,
    );
    expect(result[1][0]).toBe(1);
    expect(result[1][1]).toBe(2);
  });

  it("handles empty arrays", () => {
    expect(spotlightValue([])).toEqual([]);
  });

  it("handles empty objects", () => {
    expect(spotlightValue({})).toEqual({});
  });

  it("handles undefined values", () => {
    const result = spotlightValue(undefined);
    expect(result).toBeUndefined();
  });

  it("wraps Date as ISO string", () => {
    const policy = createPolicy(1);
    const d = new Date("2025-01-15T12:00:00Z");
    const result = spotlightValue(d, policy) as string;
    expect(result).toBe(
      `${policy.startDelimiter}2025-01-15T12:00:00.000Z${policy.endDelimiter}`,
    );
  });

  it("wraps Buffer as hex string", () => {
    const policy = createPolicy(1);
    const buf = Buffer.from("hello");
    const result = spotlightValue(buf, policy) as string;
    expect(result).toBe(
      `${policy.startDelimiter}68656c6c6f${policy.endDelimiter}`,
    );
  });

  it("wraps strings in array of objects", () => {
    const policy = createPolicy(1);
    const input = [{ a: "one" }, { b: "two" }];
    const result = spotlightValue(input, policy) as Record<string, unknown>[];
    expect(result[0].a).toBe(
      `${policy.startDelimiter}one${policy.endDelimiter}`,
    );
    expect(result[1].b).toBe(
      `${policy.startDelimiter}two${policy.endDelimiter}`,
    );
  });

  it("uses DEFAULT_POLICY when no policy given", () => {
    const result = spotlightValue("test") as string;
    expect(result.startsWith(DEFAULT_POLICY.startDelimiter)).toBe(true);
    expect(result.endsWith(DEFAULT_POLICY.endDelimiter)).toBe(true);
  });
});

describe("spotlightingPreamble", () => {
  it("returns a non-empty string", () => {
    const preamble = spotlightingPreamble();
    expect(preamble.length).toBeGreaterThan(100);
  });

  it("includes version marker", () => {
    const policy = createPolicy(3);
    const preamble = spotlightingPreamble(policy);
    expect(preamble).toContain("v3");
  });

  it("includes delimiter markers", () => {
    const policy = createPolicy(1);
    const preamble = spotlightingPreamble(policy);
    expect(preamble).toContain(policy.startDelimiter);
    expect(preamble).toContain(policy.endDelimiter);
  });

  it("includes few-shot example", () => {
    const preamble = spotlightingPreamble();
    expect(preamble).toContain("Example");
    expect(preamble).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
  });

  it("includes instruction to ignore embedded instructions", () => {
    const preamble = spotlightingPreamble();
    expect(preamble).toMatch(/never.*instruction/i);
    expect(preamble).toMatch(/data.*never/i);
  });

  it("uses DEFAULT_POLICY when no policy given", () => {
    const preamble = spotlightingPreamble();
    expect(preamble).toContain("v1");
    expect(preamble).toContain(DEFAULT_POLICY.startDelimiter);
  });

  it("different policies produce different preambles", () => {
    const policyA = createPolicy(1);
    const policyB = createPolicy(1);
    const preambleA = spotlightingPreamble(policyA);
    const preambleB = spotlightingPreamble(policyB);
    expect(preambleA).not.toBe(preambleB);
  });
});

describe("policy version distinction", () => {
  it("different versions produce different delimiter sets", () => {
    const v1 = createPolicy(1);
    const v2 = createPolicy(2);
    expect(v1.startDelimiter).not.toBe(v2.startDelimiter);
    expect(v1.endDelimiter).not.toBe(v2.endDelimiter);
  });

  it("spotlighting with different policies produces distinct output", () => {
    const policyA = createPolicy(1);
    const policyB = createPolicy(1);
    const { wrapped: wA } = spotlight("hello", policyA);
    const { wrapped: wB } = spotlight("hello", policyB);
    expect(wA).not.toBe(wB);
  });
});
