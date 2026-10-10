import type { ReactNode } from "react";
import styles from "./primitives.module.css";

export function DataTable({
  children,
  caption,
  className,
}: {
  children: ReactNode;
  caption?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.tableWrap} ${className ?? ""}`.trim()}>
      <table className={styles.table}>
        {caption && <caption>{caption}</caption>}
        {children}
      </table>
    </div>
  );
}
