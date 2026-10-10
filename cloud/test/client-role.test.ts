import { describe, expect, it } from "vitest";
import { isAdmin, roleFromAttribute } from "../client/role";

/** Issue #238: サーバが `#app` の `data-role` で渡す役割の読み取り。不明・欠落は閲覧者に倒す(管理者の入口を出さない)。 */

describe("roleFromAttribute(data-role の値 → 役割)", () => {
  // 前提: admin の行がある(全部 viewer になる退化を防ぐ)
  it.each([
    ["admin", "admin"],
    ["viewer", "viewer"],
    [undefined, "viewer"],
    [null, "viewer"],
    ["", "viewer"],
    ["Admin", "viewer"],
    ["ADMIN", "viewer"],
    [" admin", "viewer"],
    ["admin ", "viewer"],
    ["administrator", "viewer"],
    ["root", "viewer"],
  ])("%j → %s(完全一致の admin だけが管理者)", (value, expected) => {
    expect(roleFromAttribute(value)).toBe(expected);
  });

  it("isAdmin は admin だけが true(それ以外の値は false)", () => {
    expect(isAdmin("admin")).toBe(true);
    expect(isAdmin("viewer")).toBe(false);
    expect(isAdmin("root" as never)).toBe(false);
  });
});
