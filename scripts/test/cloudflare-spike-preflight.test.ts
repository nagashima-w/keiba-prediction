import { describe, expect, it } from "vitest";
import {
  SPIKE_WORKER_PREFIX,
  extractDurableObjectScriptNames,
  extractScriptNames,
  formatPreflightSuccess,
  judgeCleanup,
  judgeDeleteStatus,
  judgePreflight,
  type PreflightInput,
} from "../cloudflare-spike/preflight.js";

/**
 * #159 ワークフローの最初の関門。Secrets の存在・トークンの有効性・権限を確かめ、足りなければ
 * 何が足りないかを明示して止まる。判定は API 応答だけを入力にする純関数で、実 API は呼ばない。
 *
 * 権限名は Cloudflare が 2026-09-15 に導入した Workers のロール(Metadata Read-Only /
 * Content Read-Only / Editor / Admin。スコープは Workers product か Individual Workers)に合わせる。
 * 本スパイクは実行ごとに Worker を作成・削除するため「Admin、スコープ: Workers product」が要る。
 */

/** すべて通る入力。各テストはここから1か所だけ変える(変数を1つだけ動かす)。 */
type MutableInput = { -readonly [K in keyof PreflightInput]: PreflightInput[K] };

function allGood(): MutableInput {
  return {
    tokenPresent: true,
    accountIdPresent: true,
    userVerify: { status: 200, tokenStatus: "active" },
    accountVerify: { status: 403, tokenStatus: null },
    listScripts: { status: 200 },
    subdomain: { status: 200, subdomain: "example-user" },
    putProbe: { status: 200 },
    deleteProbe: { status: 200 },
  };
}

function codes(input: PreflightInput): string[] {
  return judgePreflight(input).problems.map((p) => p.code);
}

describe("judgePreflight: 正常系", () => {
  it("すべて通れば ok=true、problems は空、subdomain を返す", () => {
    const j = judgePreflight(allGood());
    expect(j.ok).toBe(true);
    expect(j.problems).toEqual([]);
    expect(j.subdomain).toBe("example-user");
  });

  it("アカウントトークン側の検査だけが active でも(ユーザートークン検査は401)有効とみなす", () => {
    const input = allGood();
    input.userVerify = { status: 401, tokenStatus: null };
    input.accountVerify = { status: 200, tokenStatus: "active" };
    expect(judgePreflight(input).ok).toBe(true);
  });
});

describe("judgePreflight: Secrets の存在", () => {
  it("CLOUDFLARE_API_TOKEN が未登録なら secret-missing-token で、名前を名指しして止まる(他の検査結果は見ない)", () => {
    const input = allGood();
    input.tokenPresent = false;
    const j = judgePreflight(input);
    expect(j.ok).toBe(false);
    expect(j.problems.map((p) => p.code)).toEqual(["secret-missing-token"]);
    expect(j.problems[0]!.message).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("CLOUDFLARE_ACCOUNT_ID が未登録なら secret-missing-account-id", () => {
    const input = allGood();
    input.accountIdPresent = false;
    const j = judgePreflight(input);
    expect(j.problems.map((p) => p.code)).toEqual(["secret-missing-account-id"]);
    expect(j.problems[0]!.message).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("両方未登録なら両方を報告する", () => {
    const input = allGood();
    input.tokenPresent = false;
    input.accountIdPresent = false;
    expect(codes(input)).toEqual(["secret-missing-token", "secret-missing-account-id"]);
  });
});

describe("judgePreflight: トークンの有効性", () => {
  it.each([
    { label: "失効(expired)", user: { status: 200, tokenStatus: "expired" } },
    { label: "無効化(disabled)", user: { status: 200, tokenStatus: "disabled" } },
    { label: "認証失敗(401)", user: { status: 401, tokenStatus: null } },
  ])("ユーザートークン検査が $label で、アカウントトークン検査も通らなければ token-invalid", ({ user }) => {
    const input = allGood();
    input.userVerify = user;
    input.accountVerify = { status: 401, tokenStatus: null };
    const j = judgePreflight(input);
    expect(j.ok).toBe(false);
    expect(j.problems.map((p) => p.code)).toEqual(["token-invalid"]);
    expect(j.problems[0]!.message).toContain("API トークン");
  });

  it("トークンが無効なら、権限の検査結果は見ない(無効なトークンの403を権限不足と誤読しない)", () => {
    const input = allGood();
    input.userVerify = { status: 401, tokenStatus: null };
    input.accountVerify = { status: 401, tokenStatus: null };
    input.listScripts = { status: 403 };
    input.putProbe = { status: 403 };
    expect(codes(input)).toEqual(["token-invalid"]);
  });
});

describe("judgePreflight: Workers の権限(新しいロール名で案内する)", () => {
  it("Worker 一覧が 403 なら perm-workers-list。Admin / Workers product を案内する", () => {
    const input = allGood();
    input.listScripts = { status: 403 };
    const j = judgePreflight(input);
    expect(j.problems.map((p) => p.code)).toContain("perm-workers-list");
    const msg = j.problems.find((p) => p.code === "perm-workers-list")!.message;
    expect(msg).toContain("Admin");
    expect(msg).toContain("Workers product");
  });

  it("Worker 一覧が想定外のステータス(500)なら list-unexpected で、ステータスを書く(権限不足と断定しない)", () => {
    const input = allGood();
    input.listScripts = { status: 500, bodyHead: "oops" };
    const j = judgePreflight(input);
    const p = j.problems.find((x) => x.code === "list-unexpected")!;
    expect(p.message).toContain("500");
    expect(j.problems.map((x) => x.code)).not.toContain("perm-workers-list");
  });

  it("workers.dev のサブドメインが未登録(404)なら subdomain-missing で、有効化の手順を案内する", () => {
    const input = allGood();
    input.subdomain = { status: 404 };
    const j = judgePreflight(input);
    expect(j.ok).toBe(false);
    const p = j.problems.find((x) => x.code === "subdomain-missing")!;
    expect(p.message).toContain("workers.dev");
    expect(p.message).toContain("Workers & Pages");
    expect(j.subdomain).toBeNull();
  });

  it("サブドメイン応答が 200 でも subdomain が空なら subdomain-missing", () => {
    const input = allGood();
    input.subdomain = { status: 200, subdomain: null };
    expect(codes(input)).toEqual(["subdomain-missing"]);
  });

  it("Worker の作成(PUT)が 403 なら perm-workers-create。Admin(Workers product)が要ると書き、Editor では作成できないことを添える", () => {
    const input = allGood();
    input.putProbe = { status: 403, bodyHead: "forbidden" };
    input.deleteProbe = null;
    const j = judgePreflight(input);
    expect(j.ok).toBe(false);
    const p = j.problems.find((x) => x.code === "perm-workers-create")!;
    expect(p.message).toContain("Admin");
    expect(p.message).toContain("Workers product");
    expect(p.message).toContain("Editor");
  });

  it("PUT が 401 でも perm-workers-create", () => {
    const input = allGood();
    input.putProbe = { status: 401 };
    input.deleteProbe = null;
    expect(codes(input)).toContain("perm-workers-create");
  });

  it("PUT が想定外(400)なら put-unexpected。権限不足と断定せず、プリフライト自体の不具合の可能性と本文の先頭を示す", () => {
    const input = allGood();
    input.putProbe = { status: 400, bodyHead: "bad multipart" };
    input.deleteProbe = null;
    const j = judgePreflight(input);
    const p = j.problems.find((x) => x.code === "put-unexpected")!;
    expect(p.message).toContain("400");
    expect(p.message).toContain("bad multipart");
    expect(p.message).toContain("不具合");
    expect(j.problems.map((x) => x.code)).not.toContain("perm-workers-create");
  });

  it("作成はできたが削除(DELETE)が 403 なら perm-workers-delete(Editor しか無い中途半端な状態)。残った Worker の手動削除も案内する", () => {
    const input = allGood();
    input.deleteProbe = { status: 403, bodyHead: "forbidden" };
    const j = judgePreflight(input);
    expect(j.ok).toBe(false);
    const p = j.problems.find((x) => x.code === "perm-workers-delete")!;
    expect(p.message).toContain("Admin");
    expect(p.message).toContain("Workers product");
    expect(p.message).toContain("Editor");
    expect(p.message).toContain("手動");
  });

  it("DELETE が 500 なら delete-unexpected(残骸があり得ることを書く)", () => {
    const input = allGood();
    input.deleteProbe = { status: 500 };
    const p = judgePreflight(input).problems.find((x) => x.code === "delete-unexpected")!;
    expect(p.message).toContain("500");
    expect(p.message).toContain("残");
  });

  it("PUT/DELETE が未実施(null)なら、それらの問題は出さない(前段で止まった場合など)", () => {
    const input = allGood();
    input.putProbe = null;
    input.deleteProbe = null;
    expect(judgePreflight(input).problems).toEqual([]);
  });

  it("複数の問題が同時にあれば、依存しないものはすべて報告する(一覧403 と サブドメイン未登録)", () => {
    const input = allGood();
    input.listScripts = { status: 403 };
    input.subdomain = { status: 404 };
    input.putProbe = null;
    input.deleteProbe = null;
    expect(codes(input)).toEqual(["perm-workers-list", "subdomain-missing"]);
  });
});

describe("extractScriptNames / extractDurableObjectScriptNames", () => {
  it("Cloudflare API の一覧応答(result[].id)から Worker 名を取り出す", () => {
    const json = JSON.stringify({ success: true, result: [{ id: "a" }, { id: "keiba-cf-spike-1" }] });
    expect(extractScriptNames(json)).toEqual(["a", "keiba-cf-spike-1"]);
  });

  it("壊れた JSON・result が配列でない・id が文字列でない要素は、取り出せたものだけ返す/null", () => {
    expect(extractScriptNames("{not json")).toBeNull();
    expect(extractScriptNames(JSON.stringify({ result: "x" }))).toBeNull();
    expect(extractScriptNames(JSON.stringify({ result: [{ id: 1 }, { id: "ok" }, null] }))).toEqual(["ok"]);
  });

  it("DO 名前空間の一覧(result[].script)から、所属する Worker 名を取り出す", () => {
    const json = JSON.stringify({ result: [{ id: "n1", script: "keiba-cf-spike-1", class: "SpikeDO" }, { id: "n2", script: "other" }] });
    expect(extractDurableObjectScriptNames(json)).toEqual(["keiba-cf-spike-1", "other"]);
    expect(extractDurableObjectScriptNames("{")).toBeNull();
  });
});

describe("judgeCleanup", () => {
  it("接頭辞は keiba-cf-spike-", () => {
    expect(SPIKE_WORKER_PREFIX).toBe("keiba-cf-spike-");
  });

  it("接頭辞付きの Worker が1つも無ければ ok(他の Worker は残っていても無関係)", () => {
    const j = judgeCleanup({ scriptNames: ["my-app", "other"], doScriptNames: ["my-app"] });
    expect(j.leftoverWorkers).toEqual([]);
    expect(j.ok).toBe(true);
    expect(j.durableObjectNamespaces).toBe("removed");
  });

  it("接頭辞付きの Worker が残っていれば ok=false で名前を列挙する(preflight の Worker も含む)", () => {
    const j = judgeCleanup({
      scriptNames: ["keiba-cf-spike-100-1", "my-app", "keiba-cf-spike-preflight-100"],
      doScriptNames: [],
    });
    expect(j.ok).toBe(false);
    expect(j.leftoverWorkers).toEqual(["keiba-cf-spike-100-1", "keiba-cf-spike-preflight-100"]);
  });

  it("一覧の取得に失敗(null)したら、残っていないとは言えないので ok=false(確認不能)", () => {
    const j = judgeCleanup({ scriptNames: null, doScriptNames: null });
    expect(j.ok).toBe(false);
    expect(j.listUnavailable).toBe(true);
  });

  it("DO 名前空間: 接頭辞付きの Worker に属するものが残っていれば remaining、取得失敗は unknown", () => {
    expect(judgeCleanup({ scriptNames: [], doScriptNames: ["keiba-cf-spike-1"] }).durableObjectNamespaces).toBe("remaining");
    expect(judgeCleanup({ scriptNames: [], doScriptNames: null }).durableObjectNamespaces).toBe("unknown");
  });

  it("DO 名前空間が残っていても、Worker が消えていれば ok(DO の残存は記録するが失敗にはしない)", () => {
    const j = judgeCleanup({ scriptNames: [], doScriptNames: ["keiba-cf-spike-1"] });
    expect(j.ok).toBe(true);
    expect(j.durableObjectNamespaces).toBe("remaining");
  });
});

describe("formatPreflightSuccess(サブドメインをジョブログに出さない)", () => {
  it("最初の行でサブドメインをマスクし、どの行にもサブドメインの文字列を含めない", () => {
    const lines = formatPreflightSuccess("my-secret-sub");
    expect(lines[0]).toBe("::add-mask::my-secret-sub");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line).not.toContain("my-secret-sub");
    }
    expect(lines.slice(1).join("\n")).toContain("プリフライト OK");
  });
});

describe("judgeDeleteStatus(API の DELETE の結果)", () => {
  it.each([
    { status: 200, expected: "deleted" },
    { status: 404, expected: "already-gone" },
    { status: 403, expected: "failed" },
    { status: 401, expected: "failed" },
    { status: 500, expected: "failed" },
    { status: null, expected: "failed" },
  ])("HTTP $status は $expected", ({ status, expected }) => {
    expect(judgeDeleteStatus(status)).toBe(expected);
  });
});
