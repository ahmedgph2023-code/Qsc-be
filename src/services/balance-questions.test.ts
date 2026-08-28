import { describe, expect, it } from "vitest";
import { getBalanceQuestionBoard } from "./balance-questions.js";

describe("balance question board", () => {
  it("does not sign PV or invent a bank book", () => {
    const board = getBalanceQuestionBoard();
    expect(board.signed).toBe(false);
    expect(board.inventBankLedger).toBe(false);
    expect(board.addAccountantRole).toBe(false);
    expect(board.rows.map((r) => r.id)).toEqual(["P6-PV", "P6-BANK", "P6-ROLE", "P6-CLOSES"]);
    expect(board.rows.every((r) => r.status === "blocked")).toBe(true);
  });
});
