import { describe, expect, it } from "vitest";
import { buildTargetsHash, parseHash, screenOf, TARGETS_HASH } from "../client/route";

/** Issue #336: 今日の狙い目の画面のハッシュ。`#targets`(今日)と `#targets=YYYYMMDD`(その日)。完全一致だけで、不正な値は通常の解析(一覧)に落ちる。 */

const TODAY = "20261017";

describe("狙い目画面のハッシュ", () => {
  it("#targets は狙い目画面で、日付は今日", () => {
    const route = parseHash("#targets", TODAY);
    expect(screenOf(route)).toBe("targets");
    expect(route.targets).toStrictEqual({ date: TODAY });
  });

  it("#targets=YYYYMMDD は狙い目画面で、その日を指す", () => {
    const route = parseHash("#targets=20261005", TODAY);
    expect(screenOf(route)).toBe("targets");
    expect(route.targets).toStrictEqual({ date: "20261005" });
  });

  it.each(["#targets=", "#targets=2026100", "#targets=20261340", "#targets=20261005&x=1", "#targets=abc", "#targetss", "#targets=20261005/", "targets=20261005", "#TARGETS"])(
    "完全一致しない・実在しない日付 %s は狙い目画面にならない(通常の解析に落ちる)",
    (hash) => {
      const route = parseHash(hash, TODAY);
      expect(screenOf(route)).not.toBe("targets");
      expect(route.targets).toBeUndefined();
    },
  );

  it("buildTargetsHash は parseHash と往復する。TARGETS_HASH は #targets", () => {
    expect(TARGETS_HASH).toBe("#targets");
    expect(buildTargetsHash("20261005")).toBe("#targets=20261005");
    expect(parseHash(buildTargetsHash("20261005"), TODAY).targets).toStrictEqual({ date: "20261005" });
  });

  it("他の画面のハッシュは狙い目画面にならない(設定・移行・検証・日報・一覧・レース・分析)", () => {
    for (const hash of ["#settings", "#migration", "#verify", "#report", "#report=20261005", "", "#date=20261005&venue=central", "#date=20261005&venue=nar&race=202605030811", "#analysis=5"]) {
      expect(screenOf(parseHash(hash, TODAY)), hash).not.toBe("targets");
    }
  });
});
