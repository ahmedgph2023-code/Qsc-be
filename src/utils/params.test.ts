import { describe, expect, it } from "vitest";
import { paginateMeta, queryPagination, querySearchLike, queryToken } from "./params.js";

describe("queryPagination / paginateMeta", () => {
  it("defaults to page 1 and size 10", () => {
    expect(queryPagination({})).toEqual({ page: 1, pageSize: 10 });
  });

  it("allows 10/20/25/50 only", () => {
    expect(queryPagination({ page: "2", pageSize: "20" })).toEqual({ page: 2, pageSize: 20 });
    expect(queryPagination({ pageSize: "99" }).pageSize).toBe(10);
  });

  it("clamps page to last page and computes OFFSET", () => {
    expect(paginateMeta(35, 99, 10)).toMatchObject({ page: 4, totalPages: 4, offset: 30, total: 35 });
    expect(paginateMeta(0, 3, 10)).toMatchObject({ page: 1, totalPages: 1, offset: 0, total: 0 });
  });

  it("builds a LIKE pattern and strips wildcards", () => {
    expect(querySearchLike("  MHAR  ")).toBe("%MHAR%");
    expect(querySearchLike("%x_")).toBe("%x%");
    expect(querySearchLike("")).toBeNull();
  });

  it("accepts allow-listed tokens only", () => {
    expect(queryToken("buy", /^(BUY|SELL|SP)$/i)).toBe("buy");
    expect(queryToken("nope", /^(BUY|SELL|SP)$/i)).toBeNull();
  });
});
