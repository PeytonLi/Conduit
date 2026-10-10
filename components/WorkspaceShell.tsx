import Link from "next/link";
import { Suspense } from "react";
import { signOut } from "@/app/(auth)/logout/actions";
import type { MembershipContext } from "@/lib/auth";
import type { OrganizationSummary } from "@/lib/db/queries/organization";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import styles from "./workspace-shell.module.css";

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
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">Skip to main content</a>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} href="/cases">Conduit</Link>
        <Suspense fallback={<nav aria-label="Main navigation" />}>
          <WorkspaceNavigation
            showDemo={environment === "replay" || environment === "sandbox"}
            showGetStarted={!onboardingComplete}
          />
        </Suspense>
      </aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <strong>{organization.name}</strong>
            <span className={styles.environment}>{environment === "replay" ? "Replay" : environment === "sandbox" ? "Sandbox" : "Live"}</span>
          </div>
          <div className={styles.account}>
            <span>{email ?? "Signed in"} · {membership.role}</span>
            <form action={signOut}>
              <button className={styles.signOut} type="submit">Sign out</button>
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
