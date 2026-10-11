import Link from "next/link";
import { Suspense } from "react";
import { signOut } from "@/app/(auth)/logout/actions";
import type { MembershipContext } from "@/lib/auth";
import type { OrganizationSummary } from "@/lib/db/queries/organization";
import { Icon } from "./ui/Icon";
import { LogoMark } from "./ui/Logo";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import styles from "./workspace-shell.module.css";

const environmentCopy = {
  replay: { label: "Replay", hint: "Sample data · nothing is sent", icon: "play" },
  sandbox: { label: "Sandbox", hint: "Test mode · approved test contacts only", icon: "shield" },
  live: { label: "Live", hint: "Real suppliers", icon: "phone" },
} as const;

function initials(value: string) {
  const letters = value.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase());
  return letters.join("") || "C";
}

export function WorkspaceShell({
  children,
  membership,
  organization,
  email,
  environment,
  onboardingComplete,
}: {
  children: React.ReactNode;
  membership: MembershipContext;
  organization: OrganizationSummary;
  email: string | null;
  environment: string;
  onboardingComplete: boolean;
}) {
  const env = environmentCopy[environment as keyof typeof environmentCopy] ?? environmentCopy.live;
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">Skip to main content</a>
      <aside className={styles.sidebar}>
        <Link aria-label="Conduit home" className={styles.brand} href="/cases">
          <LogoMark />
          <span>Conduit</span>
        </Link>
        <Suspense fallback={<nav aria-label="Main navigation" />}>
          <WorkspaceNavigation
            showDemo={environment === "replay" || environment === "sandbox"}
            showGetStarted={!onboardingComplete}
          />
        </Suspense>
        <div className={styles.orgCard}>
          <span aria-hidden="true" className={styles.orgAvatar}>{initials(organization.name)}</span>
          <span className={styles.orgText}>
            <strong>{organization.name}</strong>
            <small>{membership.role === "owner" ? "Owner" : membership.role === "operator" ? "Operator" : membership.role}</small>
          </span>
        </div>
      </aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={`${styles.environment} ${styles[`env_${environment}`] ?? ""}`} title={env.hint}>
              <Icon name={env.icon} size={12} />
              {env.label}
            </span>
            <span className={styles.envHint}>{env.hint}</span>
          </div>
          <div className={styles.account}>
            <span aria-hidden="true" className={styles.userAvatar}>{initials(email ?? "")}</span>
            <span className={styles.email}>{email ?? "Signed in"}</span>
            <form action={signOut}>
              <button className={styles.signOut} type="submit">
                <Icon name="logout" size={16} />
                <span>Sign out</span>
              </button>
            </form>
          </div>
        </header>
        <main className={styles.content} id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
