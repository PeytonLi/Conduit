export type OutreachChannel = "email" | "phone";

export interface OutreachDraft {
  channel: OutreachChannel;
  body: string;
  subject?: string;
}

export function outreachBodyLimit(channel: OutreachChannel): number {
  return channel === "phone" ? 200 : 5000;
}

export function validateOutreachDraft(draft: OutreachDraft): string | null {
  if (!draft.body.trim()) return "Enter a message before submitting.";
  if (draft.body.length > outreachBodyLimit(draft.channel)) {
    return `Message must be ${outreachBodyLimit(draft.channel)} characters or fewer.`;
  }
  if (draft.channel === "phone" && draft.subject?.trim()) {
    return "A subject is only available for email.";
  }
  if (draft.channel === "email" && draft.subject && draft.subject.length > 200) {
    return "Subject must be 200 characters or fewer.";
  }
  return null;
}
