import { describe, expect, it } from "vitest";
import { FORBIDDEN_AI_ACTIONS, getAiAssistantToolSurface } from "./ai-assistant.js";

describe("AI assistant governance surface (D-006)", () => {
  it("exposes no order / fee / approve / override tools", () => {
    const surface = getAiAssistantToolSurface();
    expect(surface.canExecuteTrades).toBe(false);
    expect(surface.canApproveAnything).toBe(false);
    expect(surface.canOverrideCompliance).toBe(false);
    expect(surface.canTouchFees).toBe(false);
    for (const action of FORBIDDEN_AI_ACTIONS) {
      expect(surface.forbiddenActions).toContain(action);
    }
    expect(surface.allowedPromptTypes).not.toContain("approve_mandate");
    expect(surface.allowedPromptTypes).not.toContain("create_order");
  });
});
