import { ButtonLink } from "@/components/ui/Button";
import styles from "@/components/case-route-state.module.css";

export default function CaseNotFound() {
  return (
    <section className={styles.error}>
      <h1>Case not found</h1>
      <p>It may have been closed, or you may not have access.</p>
      <ButtonLink href="/cases" variant="secondary">Back to cases</ButtonLink>
    </section>
  );
}
