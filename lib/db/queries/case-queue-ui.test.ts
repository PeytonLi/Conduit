import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/cases",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

import { CaseQueue } from "@/components/CaseQueue";

it("distinguishes an initial case-list failure from an empty organization", () => {
  const markup = renderToStaticMarkup(createElement(CaseQueue, {
    initialData: null,
    initialError: true,
    initialFilters: {},
    userId: "owner",
  }));

  expect(markup).toContain('data-state="failed-initial"');
  expect(markup).toContain("Couldn’t load cases.");
  expect(markup).not.toContain("No cases yet.");
  expect(markup).not.toContain("No problems");
});
