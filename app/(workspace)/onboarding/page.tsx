import { requireMembership } from "@/lib/auth";
import { getBusinessData } from "@/lib/db/queries/business-data";
import { listConnections } from "@/lib/db/queries/connections";
import { listCases } from "@/lib/db/queries/cases";
import { caseListQuerySchema } from "@/lib/db/queries/contracts";
import { getCurrentPolicy } from "@/lib/db/queries/policies";
import { listSuppliers } from "@/lib/db/queries/suppliers";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import styles from "./onboarding.module.css";

export default async function OnboardingPage() {
  const membership = await requireMembership();
  const [business, connections, suppliers, policy, cases] = await Promise.all([
    getBusinessData(membership),
    listConnections(membership),
    listSuppliers(membership),
    getCurrentPolicy(membership),
    listCases(membership, caseListQuerySchema.parse({ limit: 1 }), new Date()),
  ]);
  const steps = [
    {
      label: "Connect an integration",
      description: "Connect a data source so Conduit can keep your business information current.",
      href: "/settings/integrations",
      linkLabel: "Open integrations",
      complete: connections.connections.some((entry) => entry.status === "connected") ||
        Object.values(connections.environment_capabilities).some((entry) => entry.ready),
    },
    {
      label: "Load business data",
      description: "Import inventory, demand, purchase orders, and supplier information.",
      href: "/business-data",
      linkLabel: "Open business data",
      complete: business.datasets.length > 0,
    },
    {
      label: "Verify supplier contacts",
      description: "Confirm the contacts Conduit may reach when a delay needs attention.",
      href: "/suppliers",
      linkLabel: "Review suppliers",
      complete: suppliers.some((supplier) => supplier.contacts.some((contact) => contact.identity_verified)),
    },
    {
      label: "Review your policy",
      description: "Set the approval, budget, and outreach limits Conduit must follow.",
      href: "/settings/policies",
      linkLabel: "Review policies",
      complete: policy !== null,
    },
    {
      label: "Review your first case",
      description: "See the delay impact and decide what should happen next.",
      href: "/cases",
      linkLabel: "Open cases",
      complete: cases.items.length > 0,
    },
  ] as const;
  const completedSteps = steps.filter((step) => step.complete).length;
  const allComplete = completedSteps === steps.length;
  const firstIncomplete = steps.findIndex((step) => !step.complete);
  return (
    <main className={styles.page}>
      <PageHeader title="Get started" description="A few clear steps to get Conduit ready for your team." />
      <p className={styles.progress} role="status">{completedSteps} of {steps.length} done</p>
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li key={step.label}>
            <Card className={styles.stepCard}>
              <span
                aria-label={step.complete ? "Complete" : `Step ${index + 1} not complete`}
                className={step.complete ? styles.completeIcon : styles.pendingIcon}
              >
                {step.complete ? "✓" : index + 1}
              </span>
              <div className={styles.stepContent}>
                <div className={styles.stepTitle}>
                  <h2>{step.label}</h2>
                  <StatusBadge tone={step.complete ? "success" : "neutral"}>{step.complete ? "Done" : "To do"}</StatusBadge>
                </div>
                <p>{step.description}</p>
                {!allComplete && <ButtonLink href={step.href} variant={index === firstIncomplete ? "primary" : "secondary"}>{step.linkLabel}</ButtonLink>}
              </div>
            </Card>
          </li>
        ))}
      </ol>
      {allComplete && <ButtonLink href="/cases">Go to cases</ButtonLink>}
    </main>
  );
}
