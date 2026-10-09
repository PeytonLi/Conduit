import Link from "next/link";
import styles from "./workspace-shell.module.css";
import type { MembershipContext } from "@/lib/auth";

const navigation = [
  { href: "/cases", label: "Cases" },
  { href: "/business-data", label: "Business data" },
  { href: "/suppliers", label: "Suppliers" },
  { href: "/activity", label: "Activity" },
  { href: "/settings/integrations", label: "Settings" },
];

export function WorkspaceShell({
  children,
  membership,
  environment,
}: {
  children: React.ReactNode;
  membership: MembershipContext;
  environment: string;
}) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} href="/cases">
          Conduit
        </Link>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className={styles.environment}>{environment}</div>
      </aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <span>{membership.role}</span>
          <span>{membership.orgId}</span>
        </header>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
