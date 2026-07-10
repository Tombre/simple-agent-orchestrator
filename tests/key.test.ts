import { describe, expect, it } from "vitest";
import { defineKey } from "../src/index.js";

describe("defineKey", () => {
  it("builds stable namespaced keys", () => {
    const githubPr = defineKey<{ owner: string; repo: string; number: number }>("github.pr", {
      parts: ["owner", "repo", "number"],
    });

    expect(githubPr({ owner: "acme", repo: "api", number: 42 })).toBe(
      "github.pr:owner=acme:repo=api:number=42",
    );
  });
});
