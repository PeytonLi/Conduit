"use client";

import { Button } from "./ui/Button";

export function RequestReassessmentButton() {
  return (
    <Button
      onClick={() => window.dispatchEvent(new Event("conduit:request-reassessment"))}
      variant="secondary"
    >
      Request reassessment
    </Button>
  );
}
