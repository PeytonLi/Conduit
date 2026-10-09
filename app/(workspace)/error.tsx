"use client";

export default function WorkspaceError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <section role="alert">
      <h1>This page is temporarily unavailable.</h1>
      <p>Your organization data has not been changed.</p>
      <button onClick={() => retry()} type="button">Try again</button>
    </section>
  );
}
