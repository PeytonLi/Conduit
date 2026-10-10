import type { ReactNode } from "react";
import { ButtonLink } from "./Button";
import styles from "./primitives.module.css";

export function EmptyState({
  message,
  title,
  actionHref,
  actionLabel,
  className,
}: {
  message: ReactNode;
  title?: ReactNode;
  actionHref?: string;
  actionLabel?: string;
  className?: string;
}) {
  return (
    <div className={`${styles.emptyState} ${className ?? ""}`.trim()} role="status">
      {title && <h2>{title}</h2>}
      <p>{message}</p>
      {actionHref && actionLabel && <ButtonLink href={actionHref} variant="secondary">{actionLabel}</ButtonLink>}
    </div>
  );
}
