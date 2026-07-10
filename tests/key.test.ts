import { describe, expect, it } from "vitest";
import { defineKey, parseDuration } from "../src/index.js";

describe("defineKey", () => {
  it("builds stable namespaced keys", () => {
    const githubPr = defineKey<{ owner: string; repo: string; number: number }>("github.pr", {
      parts: ["owner", "repo", "number"],
    });

    expect(githubPr({ owner: "acme", repo: "api", number: 42 })).toBe(
      "github.pr:owner=acme:repo=api:number=42",
    );
  });

  it("sorts unspecified parts and percent-encodes names and values", () => {
    const key = defineKey<{ z: string; a: string }>("example");

    expect(key({ z: "two words", a: "x/y" })).toBe("example:a=x%2Fy:z=two%20words");
  });
});

describe("parseDuration", () => {
  it.each([
    [250, 250],
    ["500ms", 500],
    ["2s", 2_000],
    ["3m", 180_000],
    ["1h", 3_600_000],
  ])("parses %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each([-1, Number.POSITIVE_INFINITY, "tomorrow", "-1s"])("rejects %s", (input) => {
    expect(() => parseDuration(input)).toThrow();
  });
});
