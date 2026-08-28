/**
 * Sign-in providers offered by this app.
 * Empty by default — RankProof ships with auth off. Add Better Auth social /
 * OIDC providers here when you wire your own credentials.
 */
export type AuthProvider = {
  providerId: string;
  label: string;
};

export const AUTH_PROVIDERS: readonly AuthProvider[] = [];
