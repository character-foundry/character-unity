// The internal profile has a single local owner and no sign-in. Hub accounts plug in here later.
export interface AuthUser { id: string; username: string; displayName: string | null; avatarUrl: string | null; isAdmin: boolean }
export function useAuth(): { user: AuthUser | null; logout: () => Promise<void> } {
  return { user: null, logout: async () => {} };
}
