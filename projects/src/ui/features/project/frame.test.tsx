// The frame never moves (the nest-ui-design skill): every project view renders in the same Page, its h1
// (the project) first, with no measure on the page itself, so switching views moves neither the header
// nor the edges; only the content changes. The pixel check runs in the screenshot script (jsdom has no
// layout): the same h1 x and width, and the same content left edge, at 1440 and 1280.
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../test/render";

describe("the project views' frame", () => {
  it("is the same on Board, Manager, Reviews and Settings", async () => {
    const shapes: string[] = [];
    for (const v of ["board", "manager", "reviews", "settings"]) {
      const r = renderApp(`/projects/prj_one/${v}`);
      const h1 = await screen.findByRole("heading", { level: 1, name: "Widgets" });
      const page = h1.closest("[data-ds=page]") as HTMLElement;
      const content = page.querySelector("[data-ds=page-content]") as HTMLElement;
      // The h1's header is the content's first block, and nothing narrows or centres the page itself.
      expect(content.firstElementChild!.contains(h1), v).toBe(true);
      expect(content.getAttribute("style") ?? "", v).not.toMatch(/max-width|margin/);
      shapes.push(`${page.getAttribute("style")}|${content.getAttribute("style")}`);
      r.unmount();
    }
    expect(new Set(shapes).size).toBe(1);
  });
});
