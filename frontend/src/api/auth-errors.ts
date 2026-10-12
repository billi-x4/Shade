/** Plain-language messages for Better Auth errors, without loading the Better Auth client. */
import { NETWORK_MESSAGE } from "@/api/client";

export interface AuthClientError {
  code?: string;
  message?: string;
  status: number;
}

const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password do not match.",
  EMAIL_NOT_VERIFIED: "Verify your email first. We can send the link again.",
  USER_ALREADY_EXISTS: "An account with that email already exists. Sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "An account with that email already exists. Sign in instead.",
  PASSWORD_TOO_SHORT: "That password is too short.",
  PASSWORD_TOO_LONG: "That password is too long.",
  INVALID_TOKEN: "This link has expired or was already used. Request a new one.",
  INVALID_EMAIL: "Enter a valid email address.",
};

/** Plain-language message for a Better Auth client error. */
export function authErrorMessage(error: AuthClientError): string {
  if (error.status === 429) return "Too many tries. Wait a minute and try again.";
  if (error.status === 0) return NETWORK_MESSAGE;
  if (error.code && AUTH_MESSAGES[error.code]) return AUTH_MESSAGES[error.code] as string;
  return error.message || "That did not work. Try again.";
}
