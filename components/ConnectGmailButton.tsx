"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import styles from "./connect-gmail-button.module.css";

export const gmailConnectFailureMessage = "Gmail couldn’t be connected. Please try again.";

type GmailConnectResponse = Pick<Response, "ok" | "json">;
type GmailConnectFetch = (
  input: string,
  init: RequestInit,
) => Promise<GmailConnectResponse>;

export async function requestGmailConnection(
  fetcher: GmailConnectFetch,
  assign: (url: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const response = await fetcher("/api/auth/gmail/connect", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok) {
      onError(gmailConnectFailureMessage);
      return;
    }
    const payload = await response.json() as {
      data?: { authorization_url?: unknown };
    };
    const authorizationUrl = payload.data?.authorization_url;
    if (typeof authorizationUrl !== "string" || !authorizationUrl) {
      onError(gmailConnectFailureMessage);
      return;
    }
    assign(authorizationUrl);
  } catch {
    onError(gmailConnectFailureMessage);
  }
}

export function ConnectGmailError({ message }: { message: string }) {
  return message ? <p className={styles.error} role="alert">{message}</p> : null;
}

export function ConnectGmailButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    setError("");
    setPending(true);
    await requestGmailConnection(
      (input, init) => fetch(input, init),
      (url) => window.location.assign(url),
      setError,
    );
    setPending(false);
  }

  return (
    <div className={styles.container}>
      <Button
        className={styles.button}
        disabled={pending}
        onClick={() => void connect()}
        variant="primary"
      >
        {pending ? "Connecting…" : "Connect Gmail"}
      </Button>
      <ConnectGmailError message={error} />
    </div>
  );
}
