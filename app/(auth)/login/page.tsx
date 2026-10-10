import { Icon } from "@/components/ui/Icon";
import { LogoMark } from "@/components/ui/Logo";
import { signIn } from "./actions";
import styles from "./login.module.css";

const promises = [
  "See exactly when a delay turns into a shortage",
  "Get recovery options with real costs",
  "Nothing is committed without your approval",
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className={styles.loginPage}>
      <section aria-hidden="true" className={styles.story}>
        <div className={styles.storyBrand}>
          <LogoMark size={36} />
          <span>Conduit</span>
        </div>
        <div className={styles.storyBody}>
          <p className={styles.storyHeadline}>
            Supplier delays, <em>handled</em> before they become shortages.
          </p>
          <ul>
            {promises.map((promise) => (
              <li key={promise}>
                <span className={styles.check}><Icon name="check" size={14} strokeWidth={2.6} /></span>
                {promise}
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.preview}>
          <div className={styles.previewRow}>
            <span className={styles.previewDot} />
            <div>
              <strong>PO-1042 is 3 days late</strong>
              <small>Stock runs short Wed 9:00 AM · 600 cartons</small>
            </div>
          </div>
          <div className={styles.previewRow}>
            <span className={`${styles.previewDot} ${styles.previewDotGood}`} />
            <div>
              <strong>Recovery plan ready</strong>
              <small>Bridge order arrives Tue · waiting for you</small>
            </div>
          </div>
        </div>
      </section>
      <section className={styles.formSide}>
        <div className={styles.loginCard}>
          <div className={styles.mobileBrand}>
            <LogoMark size={30} />
            <span>Conduit</span>
          </div>
          <p className={styles.eyebrow}>Welcome back</p>
          <h1>Sign in</h1>
          <p className={styles.lede}>Pick up where your supplier recovery left off.</p>
          <form action={signIn}>
            <label>
              Email
              <input name="email" type="email" autoComplete="email" placeholder="you@company.com" required />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            {error ? (
              <p className={styles.error} role="alert">
                <Icon name="alert" size={16} />
                Sign-in failed. Check your details and try again.
              </p>
            ) : null}
            <button type="submit">
              Sign in
              <Icon name="arrowRight" size={17} />
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
