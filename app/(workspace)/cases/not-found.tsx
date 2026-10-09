import Link from "next/link";

export default function CaseNotFound() {
  return (
    <section>
      <h1>Case not found</h1>
      <p>This case isn’t available in your organization.</p>
      <Link href="/cases">Return to cases</Link>
    </section>
  );
}
