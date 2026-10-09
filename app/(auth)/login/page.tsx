import { signIn } from "./actions";
import styles from "./login.module.css";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginCard}>
        <p className={styles.eyebrow}>CONDUIT WORKSPACE</p>
        <h1>Sign in</h1>
        <p>Review supplier delays and recovery work for your organization.</p>
        <form action={signIn}>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
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
          {error ? <p role="alert">Sign-in failed. Check your details and try again.</p> : null}
          <button type="submit">Sign in</button>
        </form>
      </section>
    </main>
  );
}
