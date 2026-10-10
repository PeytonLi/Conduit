import styles from "@/components/case-route-state.module.css";

export default function WorkspaceLoading() {
  return (
    <section aria-label="Loading page" className={styles.loading} data-state="loading">
      <div aria-hidden="true" className={styles.skeleton} />
      <div aria-hidden="true" className={styles.skeleton} />
    </section>
  );
}
