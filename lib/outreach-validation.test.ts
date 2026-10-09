import { describe, expect, it } from "vitest";
import { validateOutreachDraft } from "./outreach-validation";

describe("validateOutreachDraft", () => {
  it("accepts 200 phone characters and rejects 201", () => {
    expect(validateOutreachDraft({ channel: "phone", body: "x".repeat(200) })).toBeNull();
    expect(validateOutreachDraft({ channel: "phone", body: "x".repeat(201) })).toMatch(/200 characters/);
  });

  it("accepts 5000 email characters and rejects 5001", () => {
    expect(validateOutreachDraft({ channel: "email", body: "x".repeat(5000) })).toBeNull();
    expect(validateOutreachDraft({ channel: "email", body: "x".repeat(5001) })).toMatch(/5000 characters/);
  });

  it("rejects empty and whitespace-only messages", () => {
    expect(validateOutreachDraft({ channel: "email", body: "" })).toMatch(/Enter a message/);
    expect(validateOutreachDraft({ channel: "phone", body: "   " })).toMatch(/Enter a message/);
  });

  it("allows a subject only for email", () => {
    expect(validateOutreachDraft({ channel: "email", body: "Hello", subject: "Offer" })).toBeNull();
    expect(validateOutreachDraft({ channel: "phone", body: "Hello", subject: "Offer" })).toMatch(/only available for email/);
  });
});
