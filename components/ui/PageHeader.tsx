import type { ReactNode } from "react";
import styles from "./primitives.module.css";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`${styles.pageHeader} ${className ?? ""}`.trim()}>
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className={styles.pageHeaderActions}>{actions}</div>}
    </header>
  );
}
