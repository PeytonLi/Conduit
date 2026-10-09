import styles from "@/components/case-route-state.module.css";

export default function CaseDetailLoading() {
  return (
    <section aria-label="Loading case" className={styles.error} data-state="loading">
      <div className={styles.skeleton} />
      <div className={styles.skeleton} />
      <div className={styles.skeleton} />
    </section>
  );
}
