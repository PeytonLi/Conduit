export type SupplierOnboardingStage = "candidate" | "contact_approved" | "purchasing_eligible" | "blocked";

export function supplierOnboardingStage(status: string, contactApproved: boolean): SupplierOnboardingStage {
  if (status === "blocked") return "blocked";
  if (status === "approved") return "purchasing_eligible";
  return contactApproved ? "contact_approved" : "candidate";
}
