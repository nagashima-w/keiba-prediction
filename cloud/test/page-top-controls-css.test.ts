import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page";

/**
 * Issue #544(トップの上の並びに「月報」を足し、広い画面で 1 段に収める)。
 * 並び(開催日・中央/地方・更新・狙い目・検証・日報・月報・設定)の必要幅は、Chromium の実測で約 740px(46.25rem)。
 * `main` の幅が 40rem(640px)だと「設定」が 2 段目に落ちたので、50rem(800px。端末のフォント差の余裕 60px)に広げた。
 * ここでは「その規則が書いてあること」を固定する。実際に 1 段に収まる・横スクロールが無いことは、Chromium の 1,515px・1,280px・375px の幅のスクリーンショットと寸法で確かめた(Issue #544 のコメント)。
 */
const css = (/<style>([\s\S]*?)<\/style>/.exec(renderPage("owner@example.com", "admin"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

/** セレクタ完全一致の規則の本体(`{ … }` の中)を全部返す。 */
function bodiesOf(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]!);
}

describe("トップの上の並びの CSS(Issue #544)", () => {
  it("main の最大幅は 50rem(旧 40rem)。中央寄せ・min-width: 0 は今のまま", () => {
    const main = bodiesOf("main");
    expect(main).toHaveLength(1); // 前提: スマホ画面の main の規則がちょうど 1 つ(確認ページの 32rem は別の <style>)
    expect(main[0]).toMatch(/max-width:\s*50rem/);
    expect(main[0]).toMatch(/margin:\s*0 auto/);
    expect(main[0]).toMatch(/min-width:\s*0/);
    expect(css).not.toMatch(/max-width:\s*40rem/);
  });

  it("「月報」のリンク(monthly-link)は「日報」(report-link)と同じ 1 つの規則で、同じ見た目(高さ 44px・枠・角丸)になる", () => {
    const shared = bodiesOf(".report-link, .monthly-link");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatch(/min-height:\s*44px/);
    expect(shared[0]).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(shared[0]).toMatch(/border-radius:\s*8px/);
    // 右寄せ(margin-left: auto)は検証のリンクが担う。この規則自体は寄せない
    expect(shared[0]).not.toMatch(/margin-left/);
  });

  it("設定(settings-link は margin-left: auto を持つ)が月報の直後に来ても、右へ離れない(月報の直後は margin-left: 0)", () => {
    const after = bodiesOf(".monthly-link + .settings-link");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/margin-left:\s*0/);
    // 対照: 閲覧者の並び(月報が最後)では settings-link が無いので、この規則は効かないだけで害はない
    expect(bodiesOf(".settings-link")[0]).toMatch(/margin-left:\s*auto/);
  });
});
