/**
 * ワークフロー最初の関門と後片付けの判定(Issue #159〈#21-A〉)。API 応答だけを入力にする純ロジックで、
 * 実際の Cloudflare API 呼び出しは `spikes/cloudflare/` のスクリプトが行い、結果をここへ渡す。
 *
 * 権限名は、Cloudflare が 2026-09-15 に導入した Workers のロール(Metadata Read-Only /
 * Content Read-Only / Editor / Admin。スコープは「Workers product」=アカウント内のすべての Worker、
 * または「Individual Workers」)に合わせる。旧「Workers Scripts Edit」は「Editor(Workers product)」
 * に対応するが、Editor は既存の Worker の更新・デプロイまでで、**作成と削除は Admin だけ**
 * (docs: developers.cloudflare.com/workers/authorization/workers/)。本スパイクは実行ごとに Worker を
 * 作成して削除するので「Admin、スコープ: Workers product」が要る。
 *
 * Durable Object のマイグレーション(`new_sqlite_classes`)に要る権限は docs に明記がない。
 * 初回の実行で確かめる点として、デプロイの失敗メッセージをそのまま記録する。
 */

/** スパイクが作る Worker の名前の接頭辞(後片付けの検査の対象)。 */
export const SPIKE_WORKER_PREFIX = "keiba-cf-spike-";

/** 1回の API 呼び出しの結果(本文は先頭だけ)。null は未実施。 */
export interface HttpProbe {
  readonly status: number | null;
  readonly bodyHead?: string;
}

export interface VerifyProbe extends HttpProbe {
  /** /tokens/verify の result.status(active / disabled / expired)。 */
  readonly tokenStatus?: string | null;
}

export interface SubdomainProbe extends HttpProbe {
  readonly subdomain?: string | null;
}

export interface PreflightInput {
  readonly tokenPresent: boolean;
  readonly accountIdPresent: boolean;
  readonly userVerify: VerifyProbe | null;
  readonly accountVerify: VerifyProbe | null;
  readonly listScripts: HttpProbe | null;
  readonly subdomain: SubdomainProbe | null;
  /** 最小の Worker を PUT して作成できるか。 */
  readonly putProbe: HttpProbe | null;
  /** その Worker を DELETE できるか。 */
  readonly deleteProbe: HttpProbe | null;
}

export interface PreflightProblem {
  readonly code: string;
  readonly message: string;
}

export interface PreflightJudgement {
  readonly ok: boolean;
  readonly problems: readonly PreflightProblem[];
  readonly subdomain: string | null;
}

const ROLE_HINT =
  "Cloudflare のダッシュボードで、このトークンの Workers の権限を「Admin、スコープ: Workers product」にしてください" +
  "(Editor は既存の Worker の更新・デプロイまでで、作成・削除はできません。旧「Workers Scripts Edit」は Editor に当たります)";

function head(probe: HttpProbe): string {
  return probe.bodyHead !== undefined && probe.bodyHead !== "" ? `。応答の先頭: ${probe.bodyHead}` : "";
}

/** Secrets・トークン・権限・サブドメインの検査結果から、足りないものを列挙する。 */
export function judgePreflight(input: PreflightInput): PreflightJudgement {
  const problems: PreflightProblem[] = [];

  // 1. Secrets の存在。未登録の Secret は Actions では空文字になる。
  if (!input.tokenPresent) {
    problems.push({
      code: "secret-missing-token",
      message: "リポジトリの Secrets に CLOUDFLARE_API_TOKEN が登録されていません(空です)",
    });
  }
  if (!input.accountIdPresent) {
    problems.push({
      code: "secret-missing-account-id",
      message: "リポジトリの Secrets に CLOUDFLARE_ACCOUNT_ID が登録されていません(空です)",
    });
  }
  if (problems.length > 0) {
    return { ok: false, problems, subdomain: null };
  }

  // 2. トークンの有効性。ユーザートークンとアカウントトークンの検査のどちらかが active ならよい。
  const active = (v: VerifyProbe | null): boolean =>
    v !== null && v.status === 200 && v.tokenStatus === "active";
  if (!active(input.userVerify) && !active(input.accountVerify)) {
    const describe = (label: string, v: VerifyProbe | null): string =>
      v === null ? `${label}: 未実施` : `${label}: HTTP ${v.status ?? "例外"}${v.tokenStatus ? `(${v.tokenStatus})` : ""}`;
    problems.push({
      code: "token-invalid",
      message: `CLOUDFLARE_API_TOKEN の API トークンが有効と確認できません(${describe("ユーザートークン検査", input.userVerify)} / ${describe("アカウントトークン検査", input.accountVerify)})。失効・無効化・貼り付け誤りを確認してください`,
    });
    return { ok: false, problems, subdomain: null };
  }

  // 3. Worker の一覧(読み取り)。
  if (input.listScripts !== null) {
    const s = input.listScripts.status;
    if (s === 401 || s === 403) {
      problems.push({
        code: "perm-workers-list",
        message: `Worker の一覧を読めません(HTTP ${s})。${ROLE_HINT}`,
      });
    } else if (s !== 200) {
      problems.push({
        code: "list-unexpected",
        message: `Worker の一覧が想定外の応答でした(HTTP ${s ?? "例外"})${head(input.listScripts)}`,
      });
    }
  }

  // 4. workers.dev のサブドメイン。
  let subdomain: string | null = null;
  if (input.subdomain !== null) {
    const sub = input.subdomain;
    if (sub.status === 200 && typeof sub.subdomain === "string" && sub.subdomain !== "") {
      subdomain = sub.subdomain;
    } else if (sub.status === 401 || sub.status === 403) {
      problems.push({
        code: "perm-workers-subdomain",
        message: `workers.dev のサブドメインを読めません(HTTP ${sub.status})。${ROLE_HINT}`,
      });
    } else {
      problems.push({
        code: "subdomain-missing",
        message:
          "workers.dev のサブドメインが未登録のようです。ダッシュボードの Workers & Pages を開き、" +
          `「Your subdomain」で登録してください(HTTP ${sub.status ?? "例外"})`,
      });
    }
  }

  // 5. Worker の作成(PUT)。
  if (input.putProbe !== null) {
    const s = input.putProbe.status;
    if (s === 401 || s === 403) {
      problems.push({
        code: "perm-workers-create",
        message: `最小の Worker を作成できません(HTTP ${s})。${ROLE_HINT}。新しい Worker の作成には、プロダクトレベルの Admin が要ります`,
      });
    } else if (s !== 200) {
      problems.push({
        code: "put-unexpected",
        message: `最小の Worker の作成が想定外の応答でした(HTTP ${s ?? "例外"})。権限不足とは限らず、このプリフライト自体の不具合の可能性があります${head(input.putProbe)}`,
      });
    }
  }

  // 6. Worker の削除(DELETE)。作成できたあとにだけ見る。
  if (input.deleteProbe !== null) {
    const s = input.deleteProbe.status;
    if (s === 401 || s === 403) {
      problems.push({
        code: "perm-workers-delete",
        message:
          `作成した最小の Worker を削除できません(HTTP ${s})。作成はできて削除だけできないのは、Editor 相当の権限の状態です。${ROLE_HINT}。` +
          `作成済みの ${SPIKE_WORKER_PREFIX}preflight-… という Worker は、ダッシュボードから手動で削除してください`,
      });
    } else if (s !== 200) {
      problems.push({
        code: "delete-unexpected",
        message: `最小の Worker の削除が想定外の応答でした(HTTP ${s ?? "例外"})。${SPIKE_WORKER_PREFIX}preflight-… が残っている可能性があります${head(input.deleteProbe)}`,
      });
    }
  }

  return { ok: problems.length === 0, problems, subdomain };
}

/**
 * プリフライト成功時にジョブログへ出す行。**リポジトリは public で、ジョブログは誰でも読める**ため、
 * workers.dev のサブドメイン(アカウントを特定できる)は、最初にマスクを登録し(`::add-mask::`)、
 * メッセージ本文には含めない。
 */
export function formatPreflightSuccess(subdomain: string | null): string[] {
  const lines: string[] = [];
  if (subdomain !== null && subdomain !== "") {
    lines.push(`::add-mask::${subdomain}`);
  }
  lines.push("プリフライト OK: トークン有効・Worker の作成と削除が可能・workers.dev のサブドメインを取得済み(値は表示しません)");
  return lines;
}

/** Cloudflare API の Worker 一覧応答(result[].id)から名前を取り出す。壊れていれば null。 */
export function extractScriptNames(json: string): string[] | null {
  return extractStrings(json, "id");
}

/** Durable Object 名前空間の一覧応答(result[].script)から、所属する Worker 名を取り出す。壊れていれば null。 */
export function extractDurableObjectScriptNames(json: string): string[] | null {
  return extractStrings(json, "script");
}

function extractStrings(json: string, key: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const result = (parsed as { result?: unknown }).result;
  if (!Array.isArray(result)) {
    return null;
  }
  const names: string[] = [];
  for (const item of result) {
    if (typeof item === "object" && item !== null) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string") {
        names.push(value);
      }
    }
  }
  return names;
}

export interface CleanupInput {
  /** Worker 一覧(取得に失敗したら null)。 */
  readonly scriptNames: readonly string[] | null;
  /** Durable Object 名前空間が属する Worker 名の一覧(取得に失敗したら null)。 */
  readonly doScriptNames: readonly string[] | null;
}

export interface CleanupJudgement {
  readonly leftoverWorkers: readonly string[];
  readonly durableObjectNamespaces: "removed" | "remaining" | "unknown";
  /** 接頭辞付きの Worker が残っていないと確認できた。DO の残存は ok に影響しない(記録のみ)。 */
  readonly ok: boolean;
  /** Worker 一覧が取れず、残っていないとは言えない。 */
  readonly listUnavailable: boolean;
}

/** `wrangler delete` の後の状態から、後片付けが済んだかを判定する。 */
export function judgeCleanup(input: CleanupInput): CleanupJudgement {
  const listUnavailable = input.scriptNames === null;
  const leftoverWorkers = (input.scriptNames ?? []).filter((n) => n.startsWith(SPIKE_WORKER_PREFIX));
  let durableObjectNamespaces: CleanupJudgement["durableObjectNamespaces"];
  if (input.doScriptNames === null) {
    durableObjectNamespaces = "unknown";
  } else if (input.doScriptNames.some((n) => n.startsWith(SPIKE_WORKER_PREFIX))) {
    durableObjectNamespaces = "remaining";
  } else {
    durableObjectNamespaces = "removed";
  }
  return {
    leftoverWorkers,
    durableObjectNamespaces,
    ok: !listUnavailable && leftoverWorkers.length === 0,
    listUnavailable,
  };
}
