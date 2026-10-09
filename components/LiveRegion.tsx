import styles from "./live-region.module.css";

export function LiveRegion({ message }: { message: string }) {
  return (
    <p aria-atomic="true" aria-live="polite" className={styles.liveRegion} role="status">
      {message}
    </p>
  );
}
