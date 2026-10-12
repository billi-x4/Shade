import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/** Resolves true once the merchant has re-entered their password (fresh session), false if they cancel. */
export type RequestReauth = () => Promise<boolean>;

export const ReauthContext = createContext<RequestReauth>(async () => false);

export function useRequestReauth(): RequestReauth {
  return useContext(ReauthContext);
}

export interface SecretItem {
  label: string;
  value: string;
  /** Rendered as a block (multi-line commands, long URLs). */
  block?: boolean;
}

/** A value Shade shows exactly once. */
export interface Secret {
  title: string;
  intro: ReactNode;
  items: SecretItem[];
  notes?: ReactNode[];
}

export type RevealSecret = (secret: Secret) => void;

export const SecretContext = createContext<RevealSecret>(() => {});

export function useRevealSecret(): RevealSecret {
  return useContext(SecretContext);
}
