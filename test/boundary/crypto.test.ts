import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  signCapability,
  verifyCapability,
  exportPublicKey,
  importPublicKey,
} from "../../src/boundary/crypto.js";

describe("crypto", () => {
  describe("generateKeyPair", () => {
    it("produces valid Ed25519 keypair", () => {
      const { publicKey, privateKey } = generateKeyPair();
      expect(publicKey).toBeDefined();
      expect(privateKey).toBeDefined();
      expect(publicKey.type).toBe("public");
      expect(privateKey.type).toBe("private");
    });
  });

  describe("signCapability + verifyCapability", () => {
    it("sign+verify roundtrip with canonicalized claims", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const claims = { resource: "db", operation: "read", planId: "p1" };
      const signature = signCapability(claims, privateKey);
      expect(signature).toBeTypeOf("string");
      expect(signature.length).toBeGreaterThan(0);
      expect(verifyCapability(claims, signature, publicKey)).toBe(true);
    });

    it("rejects invalid signature", () => {
      const { publicKey } = generateKeyPair();
      const claims = { resource: "db" };
      expect(verifyCapability(claims, "AAAA", publicKey)).toBe(false);
    });

    it("rejects tampered claims (field change)", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const claims = { resource: "db", operation: "read" };
      const signature = signCapability(claims, privateKey);
      expect(
        verifyCapability({ ...claims, operation: "write" }, signature, publicKey),
      ).toBe(false);
    });

    it("rejects signature from wrong key", () => {
      const { publicKey: pk1, privateKey: pk1priv } = generateKeyPair();
      const { publicKey: pk2 } = generateKeyPair();
      const claims = { resource: "db" };
      const signature = signCapability(claims, pk1priv);
      expect(verifyCapability(claims, signature, pk2)).toBe(false);
    });
  });

  describe("exportPublicKey + importPublicKey", () => {
    it("export/import roundtrip preserves signing ability", () => {
      const { publicKey, privateKey } = generateKeyPair();
      const exported = exportPublicKey(publicKey);
      expect(exported).toBeTypeOf("string");

      const imported = importPublicKey(exported);
      expect(imported.type).toBe("public");

      // Verify that a signature made with the original private key
      // can be verified with the re-imported public key
      const claims = { test: "roundtrip", value: 42 };
      const signature = signCapability(claims, privateKey);
      expect(verifyCapability(claims, signature, imported)).toBe(true);
    });

    it("export is deterministic for same key", () => {
      const { publicKey } = generateKeyPair();
      expect(exportPublicKey(publicKey)).toBe(exportPublicKey(publicKey));
    });
  });
});
