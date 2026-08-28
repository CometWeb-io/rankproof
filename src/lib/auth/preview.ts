/**
 * Local / self-host allowlist for dynamic Better Auth base URL.
 * No third-party preview broker hosts.
 */
export const PREVIEW_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;
