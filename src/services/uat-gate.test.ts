import { describe, expect, it } from "vitest";
import { getUatBoard } from "./uat-gate.js";

describe("UAT gate", () => {
  it("is not runnable and does not accept Phase 1", () => {
    const board = getUatBoard();
    expect(board.runnable).toBe(false);
    expect(board.phase1Accepted).toBe(false);
    expect(board.gapAnalysisIsNotStatus).toBe(true);
    expect(board.laterPhaseRoutesLocked).toBe(true);
    expect(board.rows.map((r) => r.id)).toContain("P10-LOCKED");
    expect(board.rows.every((r) => r.status === "blocked")).toBe(true);
  });
});
