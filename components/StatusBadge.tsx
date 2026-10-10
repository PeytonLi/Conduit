import styles from "./status-badge.module.css";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      <span aria-hidden="true" className={styles.glyph} />
      <span>{children}</span>
    </span>
  );
}
