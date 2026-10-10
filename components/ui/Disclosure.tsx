"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./primitives.module.css";

export function Disclosure({
  summary,
  children,
  count,
  className,
  defaultOpen = false,
  responsiveAtWidth,
  id,
}: {
  summary: ReactNode;
  children: ReactNode;
  count?: number;
  className?: string;
  defaultOpen?: boolean;
  responsiveAtWidth?: number;
  id?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (responsiveAtWidth === undefined) return;
    const media = window.matchMedia(`(max-width: ${responsiveAtWidth}px)`);
    const syncOpenState = () => {
      if (detailsRef.current) detailsRef.current.open = !media.matches;
    };
    syncOpenState();
    media.addEventListener("change", syncOpenState);
    return () => media.removeEventListener("change", syncOpenState);
  }, [responsiveAtWidth]);

  return (
    <details className={`${styles.disclosure} ${className ?? ""}`.trim()} id={id} open={defaultOpen || undefined} ref={detailsRef}>
      <summary>
        <span>{summary}</span>
        {count !== undefined && <span className={styles.disclosureCount}>{count}</span>}
      </summary>
      <div className={styles.disclosureContent}>{children}</div>
    </details>
  );
}
