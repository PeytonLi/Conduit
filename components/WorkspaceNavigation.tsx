"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import styles from "./workspace-navigation.module.css";

export function WorkspaceNavigation({ showDemo }: { showDemo: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = (href: string) =>
    pathname === href || (href === "/cases" && pathname.startsWith("/cases/"));
  const linkClass = (href: string) =>
    `${styles.link} ${current(href) ? styles.active : ""}`;
  const close = () => setOpen(false);

  return (
    <>
      <button
        aria-controls="primary-navigation"
        aria-expanded={open}
        className={styles.menuButton}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        Menu
      </button>
      <nav
        aria-label="Main navigation"
        className={`${styles.navigation} ${open ? styles.open : ""}`}
        id="primary-navigation"
      >
        <Link aria-current={current("/cases") ? "page" : undefined} className={linkClass("/cases")} href="/cases" onClick={close}>
          Cases
        </Link>
        <Link aria-current={current("/business-data") ? "page" : undefined} className={linkClass("/business-data")} href="/business-data" onClick={close}>
          Business data
        </Link>
        <Link aria-current={current("/suppliers") ? "page" : undefined} className={linkClass("/suppliers")} href="/suppliers" onClick={close}>
          Suppliers
        </Link>
        <Link aria-current={current("/activity") ? "page" : undefined} className={linkClass("/activity")} href="/activity" onClick={close}>
          Activity
        </Link>
        <span className={styles.sectionLabel}>Settings</span>
        <Link aria-current={current("/settings/integrations") ? "page" : undefined} className={linkClass("/settings/integrations")} href="/settings/integrations" onClick={close}>
          Integrations
        </Link>
        <Link aria-current={current("/settings/policies") ? "page" : undefined} className={linkClass("/settings/policies")} href="/settings/policies" onClick={close}>
          Policies
        </Link>
        <Link aria-current={current("/settings/members") ? "page" : undefined} className={linkClass("/settings/members")} href="/settings/members" onClick={close}>
          Members
        </Link>
        {showDemo && (
          <Link aria-current={current("/demo") ? "page" : undefined} className={linkClass("/demo")} href="/demo" onClick={close}>
            Demo
          </Link>
        )}
      </nav>
    </>
  );
}
