# Research: Ed25519 Capability Signing for pi-ship

## Summary

Capability signing uses Node.js >= 22.19 built-in `crypto.generateKeyPairSync('ed25519')`, `crypto.sign(null, data, privateKey)`, and `crypto.verify(null, data, publicKey, signature)` to produce and verify 64-byte Ed25519 signatures over canonicalized JSON claims. The design adds a `SignedCapability` wrapper around the existing `BoundaryCapability`, signs at the parent process boundary, and verifies in child/worker processes. Unsigned capabilities continue to work in `managed`/`warn` modes; `exclusive` mode enforces signature presence.

---

## Findings

### 1. Node.js Ed25519 API — available zero-dependency since v22.19.0

The `node:crypto` module provides Ed25519 key generation, signing, and verification with no third-party dependencies. The `package.json` already requires `"node": ">=22.19.0"`.

**Key generation (sync):**
```ts
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// publicKey: KeyObject (type 'public')
// privateKey: KeyObject (type 'private')
```

**Signing — `algorithm` MUST be `null` for Ed25519:**
```ts
import { sign } from "node:crypto";

const data = new TextEncoder().encode(message); // message is canonicalized string
const signature: Buffer = sign(null, data, privateKey);
// signature.length === 64 (bytes)
```

**Verification — `algorithm` MUST be `null`:**
```ts
import { verify } from "node:crypto";

const data = new TextEncoder().encode(message);
const isValid: boolean = verify(null, data, publicKey, signature);
```

**Key export for distribution (raw format, 32 bytes):**
```ts
const rawPub: Buffer = publicKey.export({ format: "raw-public" });   // 32 bytes
const rawPriv: Buffer = privateKey.export({ format: "raw-private" }); // 32 bytes
```

**Key import from raw bytes:**
```ts
import { createPublicKey, createPrivateKey } from "node:crypto";

const pubKey = createPublicKey({
  key: rawPub,
  format: "raw-public",
  asymmetricKeyType: "ed25519",
});
const privKey = createPrivateKey({
  key: rawPriv,
  format: "raw-private",
  asymmetricKeyType: "ed25519",
});
```

**Important design note:** For Ed25519, `crypto.sign()` and `crypto.verify()` take `algorithm = null`. The Ed25519 algorithm itself includes the hashing step (it uses SHA-512 internally), so no separate hash parameter is needed. This contrasts with ECDSA/RSA where you pass a digest name like `'sha256'`.

Sources: [Node.js crypto docs — generateKeyPairSync](https://nodejs.org/api/crypto.html#cryptogeneratekeypairsynctype-options), [Node.js crypto docs — sign](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback), [Node.js crypto docs — verify](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback), [Node.js Ed25519 example](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback)

---

### 2. Proposed `SignedCapability` type schema

The existing `BoundaryCapability` represents unsigned claims. `SignedCapability` wraps these claims with signature metadata.

```ts
// === Extend types.ts ===

export interface SignedCapability {
  /** The signing scheme version. Bump on algorithm/format change. */
  readonly version: 1;
  /**
   * Key identifier — the base64url-encoded Ed25519 raw public key (32 bytes).
   * Allows verifier to look up which trusted public key to use.
   */
  readonly keyId: string;
  /** The issuer identifier — e.g., process hostname, pi-ship instance ID. */
  readonly issuer: string;
  /** Intended audience — the target process/boundary that should accept this. */
  readonly audience: string;
  /** Resource this capability grants access to. */
  readonly resource: string;
  /** Operation: "read" | "write" | "execute". */
  readonly operation: "read" | "write" | "execute";
  /** Plan ID that authorised this capability. */
  readonly planId: string;
  /** Digest of the plan that authorised this capability. */
  readonly planDigest: string;
  /** Assessed risk level. */
  readonly riskLevel: "read" | "write" | "destructive";
  /** The keyId of the project binding / deployment scope. */
  readonly projectBinding: string;
  /** ISO-8601 timestamp when the capability was issued. */
  readonly issuedAt: string;
  /** ISO-8601 timestamp when the capability expires. */
  readonly expiresAt: string;
  /**
   * Unique nonce for replay prevention.
   * Generated via crypto.randomUUID() or a 128-bit random hex string.
   */
  readonly jti: string;
  /** Ed25519 signature (base64url-encoded, 64 bytes → 88 base64url chars). */
  readonly signature: string;
}
```

**Rationale for each field:**
- `version`: Enables future scheme migration without breaking old signatures.
- `keyId`: Identifies which key signed this. The public key is the key ID (hash of raw public key or the raw key itself base64url-encoded). This avoids a separate key registry index.
- `issuer`: Human-readable process identity (hostname, PID) for audit trails.
- `audience`: Binds capability to a specific target boundary. Child processes verify that `audience` matches their own identity.
- `resource`, `operation`, `planId`, `planDigest`, `riskLevel`: Mirrors existing `BoundaryCapability` fields.
- `projectBinding`: Prevents capability reuse across different deployments/projects.
- `issuedAt`, `expiresAt`: Time bounds.
- `jti`: UUID v4 per capability, checked against a recent set to prevent replay.
- `signature`: Ed25519 signature over the canonicalized claims.

Reference: [Covenant capability token shape](https://docs.opencovenant.org/capabilities) uses the same `SignedCapability { capability, signature }` pattern.

---

### 3. Key management design — ephemeral, no persistence, no rotation

**Design decision: Ephemeral keypair generated at startup.**

```
┌─────────────────────────────────────┐
│  pi-ship parent process              │
│                                     │
│  startup:                            │
│    generateKeyPairSync('ed25519')   │
│    → keypair lives only in memory   │
│                                     │
│  on each mintCapability():           │
│    sign(canonicalize(claims), priv)  │
│    → returns SignedCapability       │
│                                     │
│  on shutdown:                        │
│    keys are GC'd, never persisted   │
└─────────────────────────────────────┘
```

**Key lifecycle rules:**
1. **Generation:** On `CredentialVault` or `BoundaryEnforcer` initialization, one Ed25519 keypair is generated. Use `generateKeyPairSync('ed25519')` — synchronous, O(1ms), no event loop stall.
2. **Storage:** Private key held in a `KeyObject` field on the vault/enforcer instance. Never written to disk, never logged, never serialized. Public key exported as raw 32-byte Buffer for distribution.
3. **Rotation:** Not implemented. Ephemeral keys die with the process. A new process = a new keypair. This eliminates key rotation complexity entirely. Long-lived capabilities across process restarts are not supported (capabilities die with the signing process).
4. **Key ID derivation:** `keyId = base64url(publicKey.export({ format: 'raw-public' }))`. This is collision-free (Ed25519 public keys are 32 bytes = 2^256 space). Verifiers know which key to use by matching `keyId` against a set of trusted public keys.

**Why not persistent keys?**
- No disk I/O, no key file management, no passphrase prompts.
- No rotation ceremony. Every process start is a fresh trust domain.
- Simpler threat model: the private key window equals process lifetime.

---

### 4. Trust model

```
┌──────────────────────┐         ┌──────────────────────────┐
│  PI_SHIP             │         │  Child Process            │
│  (signer)            │         │  (verifier)               │
│                      │         │                           │
│  Has: privateKey     │         │  Receives:                │
│  Has: publicKey      │──env───▶│  - PI_SHIP_PUBLIC_KEY     │
│                      │   or    │  - SignedCapability       │
│  mintCapability():   │  pipe   │    (via env or pipe)      │
│    sign claims       │         │                           │
│    → SignedCapability│         │  verify():                │
│                      │         │    1. check keyId matches │
│                      │         │       trusted public key  │
│                      │         │    2. canonicalize claims │
│                      │         │    3. crypto.verify()     │
│                      │         │    4. check expiry        │
│                      │         │    5. check jti not used  │
└──────────────────────┘         └──────────────────────────┘
```

**Trust assumptions:**
1. **Who signs:** The pi-ship parent process that owns the `CredentialVault`. It holds the only copy of the ephemeral private key.
2. **Who verifies:** Child processes (e.g., spawned via `child_process.fork()`, `exec()`, or separate Node.js instances running pi-ship tools). Also any worker that receives a capability and needs to validate it.
3. **Public key distribution:** The parent passes its raw public key (32 bytes) to child processes via environment variable `PI_SHIP_PUBLIC_KEY` (base64url-encoded) or via the initial pipe message in the child's `process.env`.
4. **Verifier trust anchor:** The child process trusts `PI_SHIP_PUBLIC_KEY` as the root of trust for this process tree. No CA, no PKI, no external key server.

**Cross-process flow:**
```ts
// Parent (signer)
const capability = mintSignedCapability({
  resource: "db://prod",
  operation: "read",
  planId: "...",
  // ...
});
// Pass to child process
const child = fork("./worker.js", {
  env: {
    PI_SHIP_PUBLIC_KEY: rawPubBase64url,
    PI_SHIP_CAPABILITY: serializeCapability(capability),
  },
});
```

```ts
// Child (verifier)
const publicKeyRaw = Buffer.from(process.env.PI_SHIP_PUBLIC_KEY!, "base64url");
const capability = parseCapability(process.env.PI_SHIP_CAPABILITY!);
const publicKey = createPublicKey({
  key: publicKeyRaw,
  format: "raw-public",
  asymmetricKeyType: "ed25519",
});
const claims = canonicalize(excludeSignature(capability));
const isValid = verify(null, new TextEncoder().encode(claims), publicKey, signature);
```

---

### 5. Replay prevention strategy

Three-layer defense:

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| 1 | **Short TTL** — default 5 min expiration | All capabilities |
| 2 | **jti nonce** — UUID v4 per capability | All signed capabilities |
| 3 | **Optional single-use tracking** — in-memory Set of recently seen jti values | Configurable on verifier |

**Layer 1: Short TTL.** Every `SignedCapability` carries `issuedAt` and `expiresAt`. The verifier rejects any capability where `Date.now() > expiresAt`. The `mintCapability()` already uses `DEFAULT_TTL_MS = 5 * 60 * 1000`. Signed capabilities inherit this.

**Layer 2: jti.** Every minted capability gets `crypto.randomUUID()` as its `jti` field. This ensures that even if two capabilities have identical claims, their signatures differ. jti is included in the canonicalized payload, so it is signed and cannot be tampered.

**Layer 3: Optional single-use tracking.** The verifier can maintain an in-memory `Set<string>` of `jti` values seen within the TTL window. On each verification:
1. Check if `jti` is in the set → reject replay
2. Add `jti` to the set
3. Periodically evict entries older than TTL

Memory bound: at ~1000 ops/min × 5 min TTL × ~100 bytes per jti entry ≈ 500 KB. No persistence needed.

**Why not a database?** The ephemeral trust model means no shared state between processes. Each process tree has its own verifier state. If cross-process replay detection is required later, a shared Redis/Map with TTL keys can be added.

---

### 6. Backward compatibility plan

Three security modes dictate signature requirements:

| Mode | Unsigned cap allowed? | Signed cap required? |
|------|----------------------|----------------------|
| `managed` | Yes | No (signed caps validated if present) |
| `warn` | Yes (logs warning if unsigned) | No (but warns) |
| `exclusive` | No | Yes |

**Implementation approach:**

1. **`BoundaryCapability` remains the base type.** No breaking change to existing unsigned flow.
2. **`SignedCapability` extends the concept.** It adds `version`, `keyId`, `issuer`, `audience`, `projectBinding`, `jti`, `signature` fields.
3. **`mintCapability()` gains an overload** that accepts a `sign?: (claims: string) => Buffer` parameter. When a signing key is available, it produces a `SignedCapability`. When not (e.g., no private key configured), it returns a plain `BoundaryCapability`.
4. **`validateCapability()` gains a mode parameter** that controls signature validation:
   - `managed`: skip signature check entirely (current behavior)
   - `warn`: check signature if present, log warning if missing or invalid
   - `exclusive`: reject if signature missing or invalid
5. **The `CredentialVault` stores the signing keypair.** On construction, if a private key is provided (or generated), the vault can sign capabilities. The getter `get()` does *not* change its behavior — signing is a separate concern from credential access.

**Backward compat guarantee:** Existing callers that pass a `BoundaryCapability` without `signature` continue to work in `managed` and `warn` modes. Only `exclusive` mode enforces signing.

**`BoundaryCapability` type unchanged:**
```ts
// Current — no changes needed
export interface BoundaryCapability {
  readonly resource: string;
  readonly operation: "read" | "write" | "execute";
  readonly planId: string;
  readonly planDigest: string;
  readonly riskLevel: "read" | "write" | "destructive";
  readonly issuedAt: string;
  readonly expiresAt: string;
}
```

**New type added alongside:**
```ts
export interface SignedCapability extends BoundaryCapability {
  readonly version: 1;
  readonly keyId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly projectBinding: string;
  readonly jti: string;
  readonly signature: string;
}
```

---

### 7. Signature creation flow

```
mintSignedCapability(options):
  1. Build claims object (all fields except signature)
  2. claims.jti = crypto.randomUUID()
  3. claims.issuedAt = now.toISOString()
  4. claims.expiresAt = (now + ttl).toISOString()
  5. canonicalPayload = canonicalize(claims)  // existing deepSort + JSON.stringify
  6. signature = crypto.sign(null, TextEncoder.encode(canonicalPayload), privateKey)
  7. claims.signature = signature.toString('base64url')
  8. return claims as SignedCapability
```

The `canonicalize()` function already exists in `src/core/canonicalize.ts` — it sorts object keys recursively before JSON-stringifying. This ensures deterministic output across platforms and Node.js versions. The same function is used by both signer and verifier.

---

### 8. Signature verification flow

```
verifySignedCapability(signed: SignedCapability, trustedKeyId: string, trustedPublicKey: KeyObject):
  1. If signed.keyId !== trustedKeyId → return { valid: false, reason: 'keyId mismatch' }
  2. Extract signature from signed object → base64url decode to 64-byte Buffer
  3. Build claims object with all fields SAME as signing (including jti, etc.)
     → Remove signature field from claims for canonicalization
  4. canonicalPayload = canonicalize(claims)
  5. valid = crypto.verify(null, TextEncoder.encode(canonicalPayload), trustedPublicKey, signature)
  6. If !valid → return { valid: false, reason: 'signature invalid' }
  7. Check expiry: if Date.now() > new Date(signed.expiresAt).getTime()
     → return { valid: false, reason: 'capability expired' }
  8. Optional: check jti against recent set → return { valid: false, reason: 'replay detected' }
  9. Return { valid: true }
```

---

### 9. Security considerations / threat model

| Threat | Mitigation |
|--------|-----------|
| **Private key exfiltration** | Key is in-memory only, never persisted. Process isolation limits exposure. If attacker has arbitrary code execution in parent process, key is readable regardless — but at that point all credentials are compromised anyway. |
| **Replay attack** | jti + short TTL + optional single-use tracking. Replay window is at most 5 minutes. |
| **Signature forgery** | Ed25519 is existentially unforgeable under chosen-message attack (SUF-CMA). Node.js implementation delegates to OpenSSL 3.x which is FIPS 140-2 validated. |
| **Key substitution** | Verifier checks `keyId` matches the trusted public key. An attacker cannot substitute a different key because `keyId` is derived from the raw public key bytes (collision-resistant). |
| **Tampering with claims** | Claims are canonicalized and signed. Any mutation invalidates the signature. |
| **Clock skew** | Verifier uses system clock. Acceptable skew depends on deployment. Default 5 min TTL provides ample tolerance. For high-security contexts, add `nbf` (not-before) claim and clamp clock skew to 30s. |
| **Token interception (env var leakage)** | Child process env vars can be read via `/proc/[pid]/environ` on Linux. Mitigation: pass capability via pipe FD (`sendfd`) or Unix socket instead of env var. For initial implementation, env var is acceptable for single-tenant containers. |
| **Cross-process key propagation** | `PI_SHIP_PUBLIC_KEY` env var inherits to child processes. A compromised child could sign its own capabilities — but it would lack the private key. Public key alone cannot sign. |
| **Denial of service via jti tracking** | In-memory Set bounded by TTL. Attackers could flood with unique jtis to exhaust memory. Mitigation: cap jti set size (e.g., 10,000 entries) and evict oldest. |
| **Canonicalization mismatch** | Signer and verifier MUST use identical `canonicalize()` function. Using `JSON.stringify` alone is insufficient (key order undefined). The existing `deepSort` + `JSON.stringify` in `src/core/canonicalize.ts` is deterministic. |

**Non-goals (explicitly out of scope for v1):**
- Key rotation infrastructure
- Certificate authority / PKI
- Token revocation (beyond TTL expiry)
- Hardware security module (HSM) integration
- Federation / cross-instance trust

---

### 10. Integration points with existing code

| Existing code | Integration |
|---------------|-------------|
| `src/boundary/types.ts` | Add `SignedCapability` interface. Keep `BoundaryCapability` unchanged. |
| `src/boundary/capability.ts` | Add `mintSignedCapability()` that accepts a `KeyObject` private key + options, returns `SignedCapability`. Add `verifySignedCapability()` that accepts trusted public key + signed cap, returns `{ valid, reason }`. |
| `src/boundary/vault.ts` | `CredentialVault` constructor optionally accepts/creates an Ed25519 keypair. Expose `signCapability()` method. Expose `getPublicKey()` for distribution to child processes. |
| `src/boundary/enforcement.ts` | `BoundaryEnforcer.checkCredentialAccess()` — add `valid: true` path through `verifySignedCapability()` when capability carries a signature. |
| `src/core/canonicalize.ts` | `canonicalize()` is already correct for this use case. No changes needed. |
| `package.json` | No new dependencies. Ed25519 is built-in since Node 22.19.0 which is already the engine minimum. |

---

## Sources

- **Kept:** [Node.js crypto docs — Ed25519 example](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback) — Official API reference showing `sign(null, data, key)` pattern for Ed25519
- **Kept:** [Node.js generateKeyPairSync](https://nodejs.org/api/crypto.html#cryptogeneratekeypairsynctype-options) — Official reference for synchronous Ed25519 key generation
- **Kept:** [Node.js createPublicKey / createPrivateKey](https://nodejs.org/api/crypto.html#cryptocreatepublickeykey) — Raw key import/export format options for Ed25519
- **Kept:** [Covenant capability tokens](https://docs.opencovenant.org/capabilities) — Production reference for Ed25519 capability token shape, canonical encoding, verification, and revocation patterns
- **Kept:** [Stack Overflow: crypto.generateKeyPairSync('ed25519') verify](https://stackoverflow.com/questions/70408080/crypto-generatekeypairsynced25519-does-not-verify-simple-test-which-an-ec) — Confirms `crypto.sign(null, data, key)` is correct for Ed25519 (not `createSign`)
- **Kept:** [RFC 7519 — JWT jti claim](https://datatracker.ietf.org/doc/html/rfc7519#section-4.1.7) — Standard for jti nonce for replay prevention
- **Dropped:** GeeksforGeeks article — Redundant with Node.js official docs
- **Dropped:** Keygen.sh blog post — Mentions hex key conversion, not needed for raw key format

## Gaps

- **Cross-process jti sharing** — The current design uses per-process in-memory tracking. If multiple child processes independently verify the same capability, they cannot detect replay against each other. Cross-process jti coordination (Redis, shared Map) was deemed out of scope for v1.
- **Performance benchmarks** — No microbenchmarks of `crypto.sign(null, ...)`/`crypto.verify(null, ...)` throughput for Ed25519 on this specific Node.js version. Expected to be < 100µs per sign/verify based on OpenSSL Ed25519 benchmarks.
- **Fork/exec capability serialization** — The exact mechanism (env var vs. pipe vs. FD passing) needs design decisions per child process type. Research covered the env var approach; pipe passing is more secure but more complex.
- **The `audience` field trust model** — How does the child process know its own identity to match against `audience`? Options: hostname, container ID, env var `PI_SHIP_AUDIENCE`. Needs design decision.

## Supervisor coordination

No decisions needed. Research complete — all findings documented. Ready for code implementation phase.

---