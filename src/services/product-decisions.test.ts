import { describe, expect, it } from "vitest";
import { getProductDecisionBoard, listOpenProductDecisions } from "./product-decisions.js";

describe("product decision board", () => {
  it("lists open BDs as blocked and is not a sign-off", () => {
    const board = getProductDecisionBoard();
    expect(board.signed).toBe(false);
    const ids = listOpenProductDecisions().map((r) => r.id);
    for (const id of ["BD-001", "BD-007", "BD-010", "BD-011", "Q-16", "Q-18", "Q-19"]) {
      expect(ids).toContain(id);
    }
    expect(board.rows).toHaveLength(14);
    expect(board.rows.every((r) => r.status === "blocked")).toBe(true);
    const bd007 = board.rows.find((r) => r.id === "BD-007");
    expect(bd007?.codeToday.toLowerCase()).toContain("calendar");
    expect(bd007?.codeToday.toLowerCase()).not.toContain("sun–thu weekdays");
  });
});
