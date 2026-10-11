"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DisconnectGmailButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function disconnect() {
    if (!window.confirm("Disconnect Gmail? New email actions will be blocked until it is connected again.")) return;
    setPending(true);
    try {
      const response = await fetch("/api/v1/connections/gmail", {
        method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      if (response.ok) router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button disabled={pending} onClick={() => void disconnect()} type="button">
      {pending ? "Disconnecting…" : "Disconnect"}
    </button>
  );
}
