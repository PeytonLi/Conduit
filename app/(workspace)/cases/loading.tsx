import styles from "@/components/case-queue.module.css";

export default function CasesLoading() {
  return (
    <section aria-label="Loading cases" className={styles.skeleton} data-state="loading">
      <div /><div /><div />
    </section>
  );
}
