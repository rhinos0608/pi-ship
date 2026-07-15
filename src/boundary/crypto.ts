import * as crypto from "node:crypto";
import { canonicalize } from "../core/canonicalize.js";

/**
 * Generate an Ed25519 key pair using Node.js built-in crypto.
 */
export function generateKeyPair(): { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } {
  return crypto.generateKeyPairSync("ed25519");
}

/**
 * Canonicalize claims via deepSort + JSON.stringify, sign with Ed25519,
 * return base64url-encoded signature.
 */
export function signCapability(
  claims: Record<string, unknown>,
  privateKey: crypto.KeyObject,
): string {
  const canonical = canonicalize(claims);
  return crypto.sign(null, Buffer.from(canonical, "utf-8"), privateKey).toString("base64url");
}

/**
 * Canonicalize claims, verify Ed25519 signature.
 */
export function verifyCapability(
  claims: Record<string, unknown>,
  signature: string,
  publicKey: crypto.KeyObject,
): boolean {
  const canonical = canonicalize(claims);
  try {
    return crypto.verify(
      null,
      Buffer.from(canonical, "utf-8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * Export raw 32-byte public key as base64url string via JWK.
 */
export function exportPublicKey(key: crypto.KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { x: string };
  return jwk.x;
}

/**
 * Import raw public key from base64url string via JWK.
 */
export function importPublicKey(base64url: string): crypto.KeyObject {
  return crypto.createPublicKey({
    format: "jwk",
    key: { kty: "OKP", crv: "Ed25519", x: base64url },
  });
}
