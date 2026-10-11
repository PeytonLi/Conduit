import type { ReactNode } from "react";
import { ButtonLink } from "./Button";
import { Icon, type IconName } from "./Icon";
import styles from "./primitives.module.css";

export function EmptyState({
  message,
  title,
  actionHref,
  actionLabel,
  className,
  icon = "sparkle",
}: {
  message: ReactNode;
  title?: ReactNode;
  actionHref?: string;
  actionLabel?: string;
  className?: string;
  icon?: IconName;
}) {
  return (
    <div className={`${styles.emptyState} ${className ?? ""}`.trim()} role="status">
      <span className={styles.emptyIcon}><Icon name={icon} size={22} /></span>
      {title && <h2>{title}</h2>}
      <p>{message}</p>
      {actionHref && actionLabel && <ButtonLink href={actionHref} variant="secondary">{actionLabel}</ButtonLink>}
    </div>
  );
}
