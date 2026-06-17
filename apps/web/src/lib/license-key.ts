import { createHash } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const KEY_RE = /^LIC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function generateLicenseKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const segs: string[] = [];
  for (let i = 0; i < 3; i++) {
    let seg = "";
    for (let j = 0; j < 4; j++) {
      seg += ALPHABET[bytes[i * 4 + j] % ALPHABET.length];
    }
    segs.push(seg);
  }
  return `LIC-${segs.join("-")}`;
}

export function hashLicenseKey(plaintext: string): string {
  return createHash("sha256").update(plaintext.toUpperCase()).digest("hex");
}

// First 8 chars: "LIC-ABCD" — distinct enough to identify a key in admin UI
// without disclosing the full secret.
export function licenseKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, 8).toUpperCase();
}

// How long an unredeemed license stays valid. Bound licenses are permanent
// (expires_at is cleared on claim). Default 5 minutes, override with env var.
export function licenseRetentionSeconds(): number {
  const env = Number(process.env.LICENSE_RETENTION_MINUTES ?? "5");
  if (!Number.isFinite(env) || env <= 0) return 5 * 60;
  return Math.floor(env * 60);
}
