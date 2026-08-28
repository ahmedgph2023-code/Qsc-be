import { describe, expect, it } from "vitest";
import { getStatementQuestionBoard, listStatementOpenQuestions } from "./statement-questions.js";

describe("statement question board", () => {
  it("lists footer and NI questions as blocked and does not fill formulas", () => {
    const board = getStatementQuestionBoard();
    expect(board.signed).toBe(false);
    expect(board.fillFooter).toBe(false);
    expect(board.changeNiEngine).toBe(false);
    const ids = listStatementOpenQuestions().map((r) => r.id);
    expect(ids).toContain("Q-01");
    expect(ids).toContain("Q-09");
    expect(ids).toContain("Q-14");
    expect(board.rows.every((r) => r.status === "blocked")).toBe(true);
  });
});
