import { describe, expect, it } from "vitest";
import { toCsv } from "../src/csv.js";

describe("toCsv", () => {
  it("escapes commas, quotes, and newlines", () => {
    const csv = toCsv([
      {
        createdAt: new Date("2026-11-08T12:00:00Z"),
        direction: "in",
        itemType: "text",
        text: 'a,b "c"\nd',
      },
    ]);
    expect(csv).toContain('"a,b ""c""\nd"');
    expect(csv.split("\r\n")[0]).toBe("created_at,direction,item_type,text");
  });

  it("neutralizes spreadsheet formulas", () => {
    const csv = toCsv([
      {
        createdAt: new Date("2026-11-08T12:00:00Z"),
        direction: "in",
        itemType: "text",
        text: "=HYPERLINK(\"http://evil\")",
      },
    ]);
    expect(csv).toContain("'=HYPERLINK");
  });
});
