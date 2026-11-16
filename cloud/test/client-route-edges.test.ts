import { describe, expect, it } from "vitest";
import { buildEdgesHash, EDGES_HASH, parseHash, screenOf } from "../client/route";

/** Issue #644: 騎手・調教師の指標の一覧のハッシュ。`#edges`(騎手)と `#edges=trainer`(調教師)の完全一致だけ。 */

const TODAY = "20261017";

describe("指標の一覧のハッシュ", () => {
  it("#edges は騎手、#edges=trainer は調教師(取り違えない)", () => {
    const j = parseHash("#edges", TODAY);
    expect(screenOf(j)).toBe("edges");
    expect(j.edges).toStrictEqual({ kind: "jockey" });
    const t = parseHash("#edges=trainer", TODAY);
    expect(screenOf(t)).toBe("edges");
    expect(t.edges).toStrictEqual({ kind: "trainer" });
    expect(j.date).toBe(TODAY);
  });

  it.each(["#edges=", "#edges=jockey", "#edges=Trainer", "#edges=trainer&x=1", "#edgess", "#EDGES", "edges", "#edges=trainer/"])("完全一致しない %s は指標の一覧にならない", (hash) => {
    const route = parseHash(hash, TODAY);
    expect(screenOf(route)).not.toBe("edges");
    expect(route.edges).toBeUndefined();
  });

  it("buildEdgesHash は parseHash と往復する。EDGES_HASH は #edges", () => {
    expect(EDGES_HASH).toBe("#edges");
    expect(buildEdgesHash("jockey")).toBe("#edges");
    expect(buildEdgesHash("trainer")).toBe("#edges=trainer");
    for (const k of ["jockey", "trainer"] as const) expect(parseHash(buildEdgesHash(k), TODAY).edges).toStrictEqual({ kind: k });
  });
});
