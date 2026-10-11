import styles from "./status-badge.module.css";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";
type Stage = { current: number; total: number; stuck?: boolean };

export function StatusBadge({
  children,
  tone = "neutral",
  stage,
}: {
  children: React.ReactNode;
  tone?: Tone;
  stage?: Stage;
}) {
  const allDone = stage !== undefined && stage.current >= stage.total;
  const total = stage ? Math.max(0, stage.total) : 0;
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      <span className={styles.label}>{children}</span>
      {stage && (
        <>
          <span aria-hidden="true" className={styles.punchTrack}>
            {Array.from({ length: total }, (_, index) => {
              const position = index + 1;
              const punched = allDone || position < stage.current;
              const current = !allDone && position === stage.current;
              return (
                <span
                  className={[
                    styles.stagePunch,
                    punched ? styles.punched : current ? styles.current : styles.later,
                    current && stage.stuck ? styles.currentStuck : "",
                  ].filter(Boolean).join(" ")}
                  key={position}
                />
              );
            })}
          </span>
          <span className={styles.visuallyHidden}>
            {allDone ? "All stages done" : `Stage ${stage.current} of ${stage.total}`}
          </span>
        </>
      )}
    </span>
  );
}
