import * as crypto from "node:crypto";
import { generateKeyPair, signCapability, verifyCapability, exportPublicKey } from "./crypto.js";

/**
 * Holds one ephemeral Ed25519 keypair in memory.
 * Generated at construction time. Never persisted. Dies with the process.
 */
export class EphemeralKeyStore {
  readonly publicKey: crypto.KeyObject;
  readonly privateKey: crypto.KeyObject;
  private readonly publicKeyId: string;

  constructor() {
    const pair = generateKeyPair();
    this.publicKey = pair.publicKey;
    this.privateKey = pair.privateKey;
    this.publicKeyId = exportPublicKey(this.publicKey);
  }

  /** Base64url of raw public key — used as keyId in SignedCapability. */
  getPublicKeyId(): string {
    return this.publicKeyId;
  }

  /** Returns a sign function bound to the private key. */
  getSigner(): (claims: Record<string, unknown>) => string {
    return (claims) => signCapability(claims, this.privateKey);
  }

  /** Returns a verify function bound to the public key + keyId. */
  getVerifier(): { keyId: string; verify: (claims: Record<string, unknown>, signature: string) => boolean } {
    const verify = (claims: Record<string, unknown>, signature: string) =>
      verifyCapability(claims, signature, this.publicKey);
    return { keyId: this.publicKeyId, verify };
  }
}
