/**
 * Same-origin Better Auth client (/api/auth). The session lives in an HttpOnly cookie only. Loaded by
 * the auth and desk pages; reading the session alone needs only api/session.ts.
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export { authErrorMessage } from "@/api/auth-errors";
export { sessionQuery } from "@/api/session";
export type { AuthSession } from "@/api/session";
