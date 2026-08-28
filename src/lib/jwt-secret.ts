/**
 * JWT secret resolution (SEC-02).
 * Production never uses a silent fallback. Local/dev may use a known fallback with a warning
 * unless ALLOW_JWT_FALLBACK=0.
 */
const LOCAL_FALLBACK = "qatar-securities-jwt-secret-change-in-production";

export function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required when NODE_ENV=production");
  }

  if (process.env.ALLOW_JWT_FALLBACK === "0") {
    throw new Error("JWT_SECRET is required (ALLOW_JWT_FALLBACK=0)");
  }

  console.warn(
    "[auth] JWT_SECRET missing — using local-dev fallback. Set JWT_SECRET for any shared environment.",
  );
  return LOCAL_FALLBACK;
}
