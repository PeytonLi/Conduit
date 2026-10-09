"use client";

import styles from "@/components/case-route-state.module.css";

export default function CasesError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <section className={styles.error} role="alert">
      <h1>Cases are temporarily unavailable.</h1>
      <p>Your case data has not been changed.</p>
      <button onClick={() => retry()} type="button">Try again</button>
    </section>
  );
}
