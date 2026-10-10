"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon, type IconName } from "./ui/Icon";
import styles from "./workspace-navigation.module.css";

type NavItem = { href: string; label: string; icon: IconName };

export function WorkspaceNavigation({
  showDemo,
  showGetStarted,
}: {
  showDemo: boolean;
  showGetStarted: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = (href: string) =>
    pathname === href || (href === "/cases" && pathname.startsWith("/cases/"));
  const close = () => setOpen(false);

  const work: NavItem[] = [
    ...(showGetStarted ? [{ href: "/onboarding", label: "Get started", icon: "flag" as const }] : []),
    { href: "/cases", label: "Cases", icon: "inbox" },
    { href: "/business-data", label: "Business data", icon: "database" },
    { href: "/suppliers", label: "Suppliers", icon: "truck" },
    { href: "/activity", label: "Activity", icon: "activity" },
  ];
  const settings: NavItem[] = [
    { href: "/settings/integrations", label: "Integrations", icon: "plug" },
    { href: "/settings/policies", label: "Policies", icon: "shield" },
    { href: "/settings/members", label: "Members", icon: "users" },
    ...(showDemo ? [{ href: "/demo", label: "Demo", icon: "play" as const }] : []),
  ];

  const renderLink = ({ href, label, icon }: NavItem) => (
    <Link
      aria-current={current(href) ? "page" : undefined}
      className={`${styles.link} ${current(href) ? styles.active : ""}`}
      href={href}
      key={href}
      onClick={close}
    >
      <Icon className={styles.icon} name={icon} size={18} />
      <span>{label}</span>
    </Link>
  );

  return (
    <>
      <button
        aria-controls="primary-navigation"
        aria-expanded={open}
        className={styles.menuButton}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon name={open ? "close" : "menu"} size={18} />
        Menu
      </button>
      <nav
        aria-label="Main navigation"
        className={`${styles.navigation} ${open ? styles.open : ""}`}
        id="primary-navigation"
      >
        {work.map(renderLink)}
        <span className={styles.sectionLabel}>Settings</span>
        {settings.map(renderLink)}
      </nav>
    </>
  );
}
