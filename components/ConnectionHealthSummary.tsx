import type { PilotReadiness } from "@/lib/ui/pilot-readiness";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/StatusBadge";
import styles from "./connection-health-summary.module.css";

const labels: { key: keyof PilotReadiness; title: string; description: string }[] = [
  {
    key: "analysis",
    title: "Case analysis",
    description: "DeepSeek reasoning is configured for shortage assessments.",
  },
  {
    key: "email",
    title: "Supplier email",
    description: "A mailbox is connected and can read and send approved replies.",
  },
  {
    key: "voice",
    title: "Supplier voice",
    description: "Voice calling is configured for approved supplier contacts.",
  },
  {
    key: "businessWriteBack",
    title: "Business write-back",
    description: "A business system is connected so approved delivery changes can sync back.",
  },
];

export function ConnectionHealthSummary({
  readiness,
  appEnvironment,
}: {
  readiness: PilotReadiness;
  appEnvironment: "replay" | "sandbox" | "live";
}) {
  return (
    <section aria-labelledby="connection-health-heading" className={styles.section}>
      <div className={styles.header}>
        <h2 id="connection-health-heading">Connection health</h2>
        <p>
          {appEnvironment === "replay"
            ? "Replay uses fixture data; providers are marked ready for evaluation."
            : "Shows whether analysis, email, voice, and write-back are ready for live work."}
        </p>
      </div>
      <ul className={styles.grid}>
        {labels.map((item) => {
          const ready = readiness[item.key];
          return (
            <li key={item.key}>
              <Card className={styles.card}>
                <div className={styles.cardHeading}>
                  <h3>{item.title}</h3>
                  <StatusBadge tone={ready ? "success" : "warning"}>
                    {ready ? "Ready" : "Needs setup"}
                  </StatusBadge>
                </div>
                <p>{item.description}</p>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
