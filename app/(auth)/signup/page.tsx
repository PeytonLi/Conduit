import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { LogoMark } from "@/components/ui/Logo";
import { isPilotSignupEnabled, parseInviteOrgId } from "@/lib/auth/pilot-signup";
import styles from "../login/login.module.css";
import { signUp } from "./actions";

const errorCopy: Record<string, string> = {
  credentials: "Could not create your account. This email may already be registered.",
  disabled: "Self-service signup is not open on this deployment.",
  invalid: "Check the form and try again.",
  invite: "This invite link is not valid for signup.",
  organization: "Enter your organization name.",
  password: "Use at least 12 characters for your password.",
  provision: "Your account was created, but setup did not finish. Sign in and contact support.",
  membership: "Your account exists but is not assigned to an organization yet. Use an invite link or ask an owner.",
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invite?: string }>;
}) {
  const { error, invite } = await searchParams;
  const signupOpen = isPilotSignupEnabled();
  const inviteOrgId = parseInviteOrgId(invite);
  const inviteMode = Boolean(inviteOrgId);

  return (
    <main className={styles.loginPage}>
      <section aria-hidden="true" className={styles.story}>
        <div className={styles.storyBrand}>
          <LogoMark size={36} />
          <span>Conduit</span>
        </div>
        <div className={styles.storyBody}>
          <p className={styles.storyHeadline}>
            Get supplier delays under control <em>from day one</em>.
          </p>
          <ul>
            <li>
              <span className={styles.check}><Icon name="check" size={14} strokeWidth={2.6} /></span>
              Supabase-authenticated workspace access
            </li>
            <li>
              <span className={styles.check}><Icon name="check" size={14} strokeWidth={2.6} /></span>
              Guided setup for email, data, and policy
            </li>
            <li>
              <span className={styles.check}><Icon name="check" size={14} strokeWidth={2.6} /></span>
              Pilot plan — no billing during evaluation
            </li>
          </ul>
        </div>
      </section>
      <section className={styles.formSide}>
        <div className={styles.loginCard}>
          <div className={styles.mobileBrand}>
            <LogoMark size={30} />
            <span>Conduit</span>
          </div>
          <p className={styles.eyebrow}>{inviteMode ? "You are invited" : "Start your pilot"}</p>
          <h1>{inviteMode ? "Join your team" : "Create account"}</h1>
          <p className={styles.lede}>
            {inviteMode
              ? "Sign up with Supabase Auth to join your organization in Conduit."
              : "Create your organization owner account. Nothing is charged during the pilot."}
          </p>
          {!signupOpen ? (
            <p className={styles.error} role="alert">
              <Icon name="alert" size={16} />
              Signup is closed on this deployment. Ask your Conduit contact for an invite.
            </p>
          ) : (
            <form action={signUp}>
              {inviteOrgId ? (
                <input name="invite_org" type="hidden" value={inviteOrgId} />
              ) : (
                <label>
                  Organization name
                  <input
                    name="organization_name"
                    type="text"
                    autoComplete="organization"
                    placeholder="Harbor Pack"
                    required
                  />
                </label>
              )}
              <label>
                Email
                <input name="email" type="email" autoComplete="email" placeholder="you@company.com" required />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </label>
              {error ? (
                <p className={styles.error} role="alert">
                  <Icon name="alert" size={16} />
                  {errorCopy[error] ?? "Signup could not be completed. Try again."}
                </p>
              ) : null}
              <button type="submit">
                {inviteMode ? "Join organization" : "Create account"}
                <Icon name="arrowRight" size={17} />
              </button>
            </form>
          )}
          <p className={styles.lede}>
            Already have access? <Link href="/login">Sign in</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
