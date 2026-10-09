import styles from "./status-badge.module.css";

const glyphs = {
  neutral: "●",
  success: "✓",
  warning: "▲",
  danger: "✕",
  info: "?",
} as const;

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: keyof typeof glyphs;
}) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      <span aria-hidden="true">{glyphs[tone]}</span>
      <span>{children}</span>
    </span>
  );
}
