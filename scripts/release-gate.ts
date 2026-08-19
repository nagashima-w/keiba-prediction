/**
 * dev-latest 公開ゲートの機械検査(Issue #45)。
 *
 * #44-D-1(docs/versioning.md)が定めた「公開1回につき必ず1回、版数を上げる」運用を、
 * 人の目視ではなく CI 上の機械検査で強制する。判定核はすべて純関数として切り出し、
 * 依存(アセット一覧取得・exe ファイル一覧・package.json 読み取り)は注入可能にすることで、
 * `.github/workflows/build-windows.yml` へインライン bash で書く場合に起きる形骸化
 * (yml のテキストへの正規表現しか書けず、判定ロジック自体は1行も実行されないまま
 * 「テストがある体」になる。Issue #43 で実際に起きた)を避ける。
 *
 * 2つのサブコマンドを持つ:
 *
 * - `version-bump-check`: dev-latest 公開の直前に実行し、今回ビルドした exe と同名の
 *   アセットが既に dev-latest に存在する(= 版数が据え置かれたまま公開されようとしている)
 *   場合に block する。**fail-open**: アセット一覧の取得(GitHub REST API)に失敗しても
 *   公開そのものを止めない(allow + warning)。理由: リモート API の一過性障害
 *   (レート制限・トークン権限の変化・404〈dev-latest 未作成〉等)を、公開という
 *   実害の大きい操作の失敗に転嫁しないため(この検査自体が壊れても exe 配布は止めたくない)。
 *
 * - `tag-version`: 正式リリース(v* タグ push)のビルド開始直後に実行し、タグ名
 *   (`github.ref_name`)と `packages/app/package.json` の `version` が一致しない場合に
 *   block する。**fail-closed**: `packages/app/package.json` が読めない・パースできない・
 *   `version` が `X.Y.Z` 形式でない場合も block する。version-bump-check と非対称な理由は、
 *   こちらの入力(ローカルのファイル内容)はリモート API のような一過性障害が原理的に
 *   起こり得ず、決定論的に定まる値だからである。読めない/不正であること自体が
 *   「実際にリポジトリが壊れている」ことを意味する可能性が高く、それを見逃して
 *   タグ検証をスキップする方が危険(ゲートそのものが無いのと同じになる)。
 *   version-bump-check の fail-open とは目的も入力の性質も異なるため、
 *   同じ「失敗した」という現象に対して逆の既定値を選ぶのは意図的な設計判断である。
 *
 * 終了コードの写像(block→1 / allow→0 / skip→0)は `resultToExitCode` に一本化するが、
 * それだけを「配線が正しいことの証拠」にはしない(定義が1箇所であることは、呼び出し側が
 * それを経由せず `return 1` 等をインライン化しても壊れない静的事実にすぎない)。
 * 実際の担保は `scripts/test/release-gate.test.ts` の `dispatch()` に対するふるまいテスト
 * (5セル: version-bump-check の block/allow/skip、tag-version の block(不一致)/
 * block(不正)/allow を、実際に返る終了コード整数で個別に固定する)が負う。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 共通の判定結果型
// ---------------------------------------------------------------------------

/**
 * 判定結果。
 * - block: 公開・リリースを止める(exit 1)。
 * - allow: 通常どおり進める(exit 0)。message があれば警告として残す
 *   (取得失敗等、判定はできなかったが公開は止めない場合)。
 * - skip: 判定そのものができなかったため進める(exit 0)。allow と exit code は同じだが、
 *   「判定して問題なしと分かった」のか「判定できなかった」のかを区別するために状態を分ける。
 */
export type GateResult =
  | { status: "block"; message: string }
  | { status: "allow"; message?: string }
  | { status: "skip"; message: string };

/**
 * 終了コードへの写像。block だけが 1、それ以外はすべて 0。
 * この関数単体のテストに加え、`dispatch()` を実際に呼ぶふるまいテストで
 * 呼び出し側がこれを経由していることを別途担保する(コメント冒頭参照)。
 */
export function resultToExitCode(result: GateResult): number {
  return result.status === "block" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// version-bump-check: exe 名の解決
// ---------------------------------------------------------------------------

export type ExeResolution =
  | { ok: true; name: string }
  | { ok: false; result: GateResult };

/**
 * release ディレクトリの .exe ファイル名一覧から、現行ビルドの exe 名を一意に解決する。
 * portable ターゲットのみの設定では exe は常に1個生成される前提だが、将来 target が
 * 増えて複数生成される設定に変わった場合や、ビルド失敗で0個の場合は
 * 判定不能として skip する(既存の孤児掃除ステップの exe_count ガードと同じ考え方)。
 */
export function resolveSingleExeName(fileNames: string[]): ExeResolution {
  if (fileNames.length === 0) {
    return {
      ok: false,
      result: {
        status: "skip",
        message:
          "release ディレクトリに .exe が見つかりません(0個)。exe 生成後を前提とする検査のため版数据え置き検査をスキップします",
      },
    };
  }
  if (fileNames.length > 1) {
    return {
      ok: false,
      result: {
        status: "skip",
        message: `release ディレクトリの .exe が1個ではありません(${fileNames.length}個)。target 追加等で前提が変わった可能性があるため版数据え置き検査をスキップします`,
      },
    };
  }
  const [name] = fileNames;
  if (name === undefined) {
    throw new Error(
      "到達しないはずの分岐です(fileNames.length===1のはずが要素を取得できません)",
    );
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// version-bump-check: dev-latest アセット一覧の取得(失敗種別を区別する)
// ---------------------------------------------------------------------------

export type AssetFetchErrorKind = "not_found" | "http_error" | "network_error";

/**
 * dev-latest のアセット一覧取得に失敗したことを表す例外。種別を保持することで、
 * 404(dev-latest 未作成)・403/5xx(トークン権限退行やサーバ障害)・
 * ネットワーク例外(タイムアウト含む)を呼び出し側が文言で区別できるようにする。
 * 401/403/5xx を 404 と同じ扱いにすると「検査が毎回スキップされ続けているのに
 * 誰も気づかない」という #45 が防ごうとしている形骸化と同型の問題が起こるため、
 * fail-open にする(スキップして進める)こと自体は維持しつつ、種別は必ず警告文に残す。
 */
export class AssetFetchError extends Error {
  readonly kind: AssetFetchErrorKind;
  readonly status?: number;

  constructor(kind: AssetFetchErrorKind, options?: { status?: number; cause?: unknown }) {
    super(
      `dev-latest アセット一覧の取得に失敗しました(種別=${kind}${
        options?.status !== undefined ? `, status=${options.status}` : ""
      })`,
    );
    this.name = "AssetFetchError";
    this.kind = kind;
    this.status = options?.status;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** GitHub REST API 呼び出しのタイムアウト(ミリ秒)。 */
const GITHUB_API_TIMEOUT_MS = 10_000;

/**
 * dev-latest リリースのアセット名一覧を GitHub REST API から取得する(実装。Node 22 内蔵
 * fetch を使用、`gh` の spawn はしない)。`AbortSignal.timeout` でタイムアウトを明示する。
 * fail-open 設計(呼び出し側で allow+warning に落とす)と対になっており、ここでハングすると
 * 「検査の失敗を公開の失敗に転嫁しない」という意図が「検査が終わらず公開も進まない」という
 * 別の形で壊れてしまうため、無期限待機を避けるタイムアウトは必須とする。
 */
export async function fetchDevLatestAssetNamesReal(params: {
  owner: string;
  repo: string;
  token: string;
}): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${params.owner}/${params.repo}/releases/tags/dev-latest`,
      {
        headers: {
          Authorization: `Bearer ${params.token}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      },
    );
  } catch (cause) {
    // fetch() 自体の reject(DNS失敗・タイムアウト等)。AbortSignal.timeout による中断は
    // DOMException(name: "TimeoutError") として reject されるため、ここに一括して来る。
    throw new AssetFetchError("network_error", { cause });
  }

  if (response.status === 404) {
    throw new AssetFetchError("not_found");
  }
  if (!response.ok) {
    throw new AssetFetchError("http_error", { status: response.status });
  }

  const body = (await response.json()) as { assets?: Array<{ name?: unknown }> };
  return (body.assets ?? [])
    .map((asset) => asset.name)
    .filter((name): name is string => typeof name === "string");
}

// ---------------------------------------------------------------------------
// version-bump-check: 判定本体
// ---------------------------------------------------------------------------

/** blocked 時のメッセージに必ず含める固定句(scripts/test で toContain 検査する)。 */
const VERSION_BUMP_GUIDANCE =
  "docs/versioning.md の同時更新チェックリストに従って版数を上げる必要があります(誤検知の場合は workflow_dispatch で再送できるはずです)";

export interface VersionBumpCheckDeps {
  listExeFileNames: () => string[];
  fetchAssetNames: () => Promise<string[]>;
}

export async function judgeVersionBump(deps: VersionBumpCheckDeps): Promise<GateResult> {
  const resolution = resolveSingleExeName(deps.listExeFileNames());
  if (!resolution.ok) {
    return resolution.result;
  }
  const currentExeName = resolution.name;

  let existingAssetNames: string[];
  try {
    existingAssetNames = await deps.fetchAssetNames();
  } catch (error) {
    if (error instanceof AssetFetchError) {
      if (error.kind === "not_found") {
        return {
          status: "allow",
          message:
            "dev-latest のアセット一覧取得に失敗しました(HTTP 404: dev-latest が存在しません)。初回公開とみなし版数据え置き検査をスキップします",
        };
      }
      if (error.kind === "http_error") {
        return {
          status: "allow",
          message: `dev-latest のアセット一覧取得に失敗しました(HTTP ${error.status})。トークン権限の変化やレート制限の可能性があります。次回のビルドで再試行されます`,
        };
      }
      const detail =
        error.cause instanceof Error
          ? `${error.cause.name}: ${error.cause.message}`
          : String(error.cause);
      return {
        status: "allow",
        message: `dev-latest のアセット一覧取得中にネットワークエラー(タイムアウトを含む)が発生しました(${detail})。次回のビルドで再試行されます`,
      };
    }
    return {
      status: "allow",
      message: `dev-latest のアセット一覧取得で予期しないエラーが発生しました(${
        error instanceof Error ? error.message : String(error)
      })。次回のビルドで再試行されます`,
    };
  }

  const normalizedCurrent = currentExeName.toLowerCase();
  const hasSameAsset = existingAssetNames.some(
    (name) => name.toLowerCase() === normalizedCurrent,
  );
  if (hasSameAsset) {
    return {
      status: "block",
      message: `dev-latest に現在ビルドした exe と同名のアセット(${currentExeName})が既に存在します。バージョンが据え置かれたまま公開しようとしている可能性があります。${VERSION_BUMP_GUIDANCE}`,
    };
  }
  return { status: "allow" };
}

// ---------------------------------------------------------------------------
// tag-version: 判定本体
// ---------------------------------------------------------------------------

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export interface TagVersionCheckDeps {
  readAppVersion: () => string;
}

export function judgeTagVersion(deps: TagVersionCheckDeps, refName: string): GateResult {
  let version: string;
  try {
    version = deps.readAppVersion();
  } catch (error) {
    // fail-closed(スクリプト冒頭コメント参照): ここでの失敗はリモート API の一過性障害では
    // あり得ず、リポジトリの実際の欠陥(ファイル破損・キー欠落等)を意味する可能性が高いため、
    // 「不一致」とは別の文言で block する。
    return {
      status: "block",
      message: `packages/app/package.json の version を読み取れないか、不正です(${
        error instanceof Error ? error.message : String(error)
      })。タグの一致検証を続行できません`,
    };
  }

  if (!RELEASE_VERSION_PATTERN.test(version)) {
    return {
      status: "block",
      message: `packages/app/package.json の version(${version})が X.Y.Z 形式ではありません。プレリリース識別子・ビルドメタデータは使用できません(docs/versioning.md)`,
    };
  }

  const expectedTag = `v${version}`;
  if (refName !== expectedTag) {
    return {
      status: "block",
      message: `タグ(${refName})が packages/app/package.json の version(${version})と一致しません。期待されるタグ名: ${expectedTag}`,
    };
  }

  return { status: "allow" };
}

// ---------------------------------------------------------------------------
// 実ファイルシステムに触れる実装(スクリプト自身のディレクトリ基準に解決する)
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, "..");
const RELEASE_DIR = path.join(REPO_ROOT, "packages/app/release");
const APP_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "packages/app/package.json");

export function listReleaseExeFileNamesReal(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(RELEASE_DIR);
  } catch {
    // ディレクトリが無い場合も「0個」として扱う(resolveSingleExeName が skip を返す)。
    return [];
  }
  return entries.filter((name) => name.toLowerCase().endsWith(".exe"));
}

export function readAppVersionReal(): string {
  const raw = readFileSync(APP_PACKAGE_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(
      `version フィールドが見つからないか文字列ではありません: ${APP_PACKAGE_JSON_PATH}`,
    );
  }
  return parsed.version;
}

// ---------------------------------------------------------------------------
// CLI ディスパッチ(薄い配線。判定核は上記の純関数が担う)
// ---------------------------------------------------------------------------

export interface RealDeps {
  listExeFileNames: () => string[];
  fetchAssetNames: () => Promise<string[]>;
  readAppVersion: () => string;
}

export interface DispatchOutcome {
  exitCode: number;
  logs: string[];
}

function formatLogLine(result: GateResult, okLabel: string): string {
  if (result.status === "block") {
    return `::error::${result.message}`;
  }
  if (result.status === "skip") {
    return `::warning::${result.message}`;
  }
  // allow
  return result.message !== undefined ? `::warning::${result.message}` : okLabel;
}

/**
 * サブコマンドを解釈して判定を実行し、終了コードとログ行を返す。
 * これ自体はテストで直接呼び出し、5つのケース(version-bump-check の block/allow/skip、
 * tag-version の block(不一致)/block(不正)/allow)それぞれについて **実際に返る整数**を
 * 固定する(スクリプト冒頭コメント参照。静的な「定義が1箇所」だけに頼らない)。
 */
export async function dispatch(argv: string[], deps: RealDeps): Promise<DispatchOutcome> {
  const [subcommand, arg1] = argv;

  if (subcommand === "version-bump-check") {
    const result = await judgeVersionBump({
      listExeFileNames: deps.listExeFileNames,
      fetchAssetNames: deps.fetchAssetNames,
    });
    return {
      exitCode: resultToExitCode(result),
      logs: [formatLogLine(result, "版数据え置き検査: 問題ありません(公開を続行します)")],
    };
  }

  if (subcommand === "tag-version") {
    if (arg1 === undefined) {
      const result: GateResult = {
        status: "block",
        message: "タグ名(github.ref_name)が引数として渡されていません",
      };
      return { exitCode: resultToExitCode(result), logs: [formatLogLine(result, "")] };
    }
    const result = judgeTagVersion({ readAppVersion: deps.readAppVersion }, arg1);
    return {
      exitCode: resultToExitCode(result),
      logs: [formatLogLine(result, `タグ検証: 一致しました(${arg1})`)],
    };
  }

  const result: GateResult = {
    status: "block",
    message: `未知のサブコマンドです: ${
      subcommand ?? "(未指定)"
    }(version-bump-check | tag-version のいずれかを指定してください)`,
  };
  return { exitCode: resultToExitCode(result), logs: [formatLogLine(result, "")] };
}

// ---------------------------------------------------------------------------
// 実プロセスとして起動された場合のエントリポイント
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const [owner = "", repo = ""] = repository.includes("/")
    ? repository.split("/")
    : ["", ""];
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";

  const realDeps: RealDeps = {
    listExeFileNames: listReleaseExeFileNamesReal,
    fetchAssetNames: () => fetchDevLatestAssetNamesReal({ owner, repo, token }),
    readAppVersion: readAppVersionReal,
  };

  const outcome = await dispatch(process.argv.slice(2), realDeps);
  for (const line of outcome.logs) {
    console.log(line);
  }
  process.exitCode = outcome.exitCode;
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  void main();
}
