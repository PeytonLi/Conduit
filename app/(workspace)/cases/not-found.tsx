import { ButtonLink } from "@/components/ui/Button";
import styles from "@/components/case-route-state.module.css";

export default function CaseNotFound() {
  return (
    <section className={styles.error}>
      <h1>Case not found</h1>
      <p>This case isn’t available in your organization.</p>
      <ButtonLink href="/cases" variant="secondary">Return to cases</ButtonLink>
    </section>
  );
}
