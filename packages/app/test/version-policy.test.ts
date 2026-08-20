/**
 * 版数運用規約(Issue #44-D-1、docs/versioning.md)に関する不変条件テスト。
 *
 * 背景: exe のファイル名(electron-builder.yml の artifactName)は
 * packages/app/package.json の version から作られる。この版数は 2026-08-04 の手動更新
 * (1.0.0 → 1.1.0)以来 94 コミット据え置かれ、その間に組み合わせオッズ取得・券種横断の
 * 予算配分など明確な機能追加が入った。「手で上げる」運用は既に一度確立され、そして破れている。
 *
 * 本タスクでは (1) root/app の version を 1.1.0 → 1.2.0 に是正し、(2) 「公開1回につき必ず1回
 * 上げる」という運用規約を docs/versioning.md に明文化し、(3) 版数を書いている文書
 * (docs/current-spec.md・keiba-ev-tool-spec.md)を同期し、(4) それらの不変条件を本ファイルで
 * 機械的に固定する。
 *
 * テストの作り方(release-workflow-gate.test.ts の流儀を踏襲):
 * - 判定ロジックは純関数(versionsInSync / isReleaseVersion / extractVersionMentions)に
 *   切り出し、まず異常入力(不一致・プレリリース識別子・部分一致誤判定)に対する Red を
 *   確認してから実装する。
 * - 実ファイルへ当てる配線テストは、判定ロジックが正しいことを前提に別途 1 件ずつ置く。
 * - 文書テキストへの正規表現は CI(windows-latest)の CRLF を考慮し、readNormalized を通した
 *   テキストに対してのみ行う(release-workflow-gate.test.ts の readNormalized と同じ理由。
 *   同ファイル内で 1 箇所だけ生読みにする見落としが過去に実際に起きているため、本ファイルの
 *   全ファイル読み込みは例外なく readNormalized を通す)。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(currentDir, "../../..");

const ROOT_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const APP_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "packages/app/package.json");
const CORE_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "packages/core/package.json");
const ELECTRON_BUILDER_YML_PATH = path.join(
  REPO_ROOT,
  "packages/app/electron-builder.yml",
);
const CURRENT_SPEC_PATH = path.join(REPO_ROOT, "docs/current-spec.md");
const SPEC_PATH = path.join(REPO_ROOT, "keiba-ev-tool-spec.md");
const VERSIONING_DOC_PATH = path.join(REPO_ROOT, "docs/versioning.md");

/**
 * テキストファイルを読み、改行コードを LF に正規化して返す。
 * CI(windows-latest)の checkout は .gitattributes 次第で CRLF になりうる。本ファイルで
 * 文書テキストに正規表現を当てるすべての箇所は、この関数を通した正規化済みテキストに対して
 * 行う(release-workflow-gate.test.ts と同じ理由・同じ手当て)。
 *
 * 注記(#44-D-1 のメタレビュー差し戻し 要修正A): 実測すると、本ファイルが当てる正規表現・toContain の
 * うち複数(例: /自動判定[\s\S]{0,200}(採らない|採用しない)/ は一致長76文字中に改行3個、
 * /対象外[\s\S]{0,200}(private|npm)/ は一致長177文字中に改行4個)が改行をまたいでいる。
 * それでもこの正規化を外して全件緑のままなのは、しきい値(200/80/60文字)に対して
 * CRLF による `\r` の増分(改行の出現数と同数)が十分小さく、一致の成否を左右しないため。
 * D-2(#45)申し送りパターン(/D-2[\s\S]{0,60}workflow_dispatch[\s\S]{0,60}除外/)は
 * `{0,60}` の隙間が独立に2箇所ある(合算の単一予算ではない)。実測: gap1(D-2〜workflow_dispatch)は
 * 18文字(改行1個を含む)でしきい値60への余裕42文字、gap2(workflow_dispatch〜除外)は13文字
 * (改行なし)で余裕47文字。余裕が薄いのは改行を含む gap1 のほうで、実際に gap1 だけを42文字
 * 広げる注入実験(このコメントを書いた本人が実行)では LF=緑・CRLF=赤に転じ、43文字広げると
 * 両方赤になる(41文字までは両方緑)。今この関数を外しても全件緑という結論は変わらないが、
 * 将来パターンが伸びたときの予防として本正規化を維持する。
 */
function readNormalized(filePath: string): string {
  return readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

// ---------------------------------------------------------------------------
// 判定ロジック(純関数)
// ---------------------------------------------------------------------------

/** root/app の package.json バージョンが一致しているかを判定する。 */
function versionsInSync(rootVersion: string, appVersion: string): boolean {
  return rootVersion === appVersion;
}

/**
 * 版数文字列が正式版の形式(X.Y.Z のみ)であるかを判定する。
 * プレリリース識別子(-dev.1 等)・ビルドメタデータ(+build 等)・v 接頭辞・不足桁(1.2)・
 * 前後の空白は、すべて不正として弾く。
 */
function isReleaseVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/**
 * テキストから、与えられたベース版数(例 "1.2.0")の出現を単語境界つきで抽出する。
 * v 接頭辞ありなし両方を拾う。前後に数字・ドットが続く場合は部分一致とみなして除外する
 * (素朴な includes/非境界正規表現だと "1.2.0" が "11.2.0" や "1.2.01" にも一致してしまうため)。
 */
function extractVersionMentions(text: string, baseVersion: string): string[] {
  const escaped = baseVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\d.])v?${escaped}(?![\\d.])`, "g");
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

/**
 * docs/versioning.md に、与えられた版数に対応する「次の正式版が X.Y.Z である根拠」見出しが
 * 存在するかを判定する(code-reviewer 一次レビュー 提案1 の一般化採用)。
 *
 * literal な版数(例 "1.2.1")を直接ピン留めするテストは、版を上げるたびに専用テストが
 * 積み上がり将来誰も読まなくなるため採らない。代わりにこの汎用の不変条件を EXPECTED_APP_VERSION
 * と組み合わせて使うことで、「版を上げたら根拠セクションを書く」ことを機械的に強制する
 * (docs/versioning.md の同時更新チェックリストが既に持つ「意図的な摩擦」と同じ設計思想)。
 *
 * 検出パターンは docs/versioning.md に実在する見出しの字句
 * (`## 次の正式版が 1.2.0 である根拠(...)`・`## 次の正式版が 1.2.1 である根拠(...)`)に
 * 合わせている。見出し記号(`## `)や末尾の丸括弧注記までは要求せず、版数の前後の空白は
 * `\s+` で許容する(表記ゆれによる偽陰性を避ける一方、"次の正式版が…である根拠" という
 * 核となる字句は固定する)。
 */
function hasVersionRationaleSection(doc: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`次の正式版が\\s+${escaped}\\s+である根拠`);
  return pattern.test(doc);
}

// ---------------------------------------------------------------------------
// 純関数のテスト(異常系を先に固定する)
// ---------------------------------------------------------------------------

describe("純関数: versionsInSync(root/app の版数一致判定)", () => {
  it("root と app が同一なら一致とみなす", () => {
    expect(versionsInSync("1.2.0", "1.2.0")).toBe(true);
  });

  it("片方だけ上げる事故を検出する(不一致は false)", () => {
    // ここが本テストの核心: 「片方だけ上げる」という実際に起きた事故形を再現する。
    expect(versionsInSync("1.1.0", "1.2.0")).toBe(false);
    expect(versionsInSync("1.2.0", "1.1.0")).toBe(false);
  });
});

describe("純関数: isReleaseVersion(X.Y.Z 形式の判定)", () => {
  it("X.Y.Z 形式は正式版として受理する", () => {
    expect(isReleaseVersion("1.2.0")).toBe(true);
    expect(isReleaseVersion("0.2.0")).toBe(true);
    expect(isReleaseVersion("10.20.30")).toBe(true);
  });

  it("プレリリース識別子・ビルドメタデータ・v接頭辞・不足桁・前後空白を弾く", () => {
    // 規約(docs/versioning.md)は「プレリリース識別子は使わない。X.Y.Z のみ」と定める。
    // ここでその境界を1件ずつ固定する。
    expect(isReleaseVersion("1.2.0-dev.1")).toBe(false);
    expect(isReleaseVersion("1.2.0+build.5")).toBe(false);
    expect(isReleaseVersion("v1.2.0")).toBe(false);
    expect(isReleaseVersion("1.2")).toBe(false);
    expect(isReleaseVersion(" 1.2.0")).toBe(false);
    expect(isReleaseVersion("1.2.0 ")).toBe(false);
  });
});

describe("純関数: extractVersionMentions(単語境界つき版数抽出)", () => {
  it("裸表記と v 接頭辞表記の両方を単語境界つきで拾う", () => {
    const text = "現状(v1.2.0)。ルート/アプリ `1.2.0`。";
    const mentions = extractVersionMentions(text, "1.2.0");

    // 前提固定: 2件(v接頭辞1件・裸1件)拾えていること。0件のまま以降のアサーションが
    // 自明に成立する空振りを避ける。
    expect(mentions.length).toBe(2);
    expect(mentions).toContain("v1.2.0");
    expect(mentions).toContain("1.2.0");
  });

  it("部分一致誤判定を避ける(11.2.0 や 1.2.01 には一致しない)", () => {
    // 素朴な包含判定(text.includes(base))は "11.2.0" にも "1.2.01" にも一致してしまう。
    // ここでその誤検出を固定する。
    const text = "旧版は 11.2.0 と誤記され、別の版は 1.2.01 と誤記された。";
    const mentions = extractVersionMentions(text, "1.2.0");

    expect(mentions.length).toBe(0);
  });

  it("部分一致誤判定を避けつつ、正しい単独表記は引き続き拾う(誤って全滅させていないことの確認)", () => {
    // 上のテストが「何も拾わない」という縮退した実装(常に空配列を返す)でも通ってしまう
    // 空振りを避けるため、部分一致の誤記と正しい表記が同一テキストに混在する場合に
    // 正しい表記だけを拾えることを確認する。
    const text = "旧版は 11.2.0 と誤記されたが、正しい版数は 1.2.0 である。";
    const mentions = extractVersionMentions(text, "1.2.0");

    expect(mentions).toEqual(["1.2.0"]);
  });
});

describe("純関数: hasVersionRationaleSection(版数根拠セクションの検出。code-reviewer 一次レビュー 提案1)", () => {
  const doc =
    "## 次の正式版が 1.2.0 である根拠(本タスクでの是正)\n\n1.1.0 以降...\n\n" +
    "## 次の正式版が 1.2.1 である根拠(Issue #45 での是正)\n\nIssue #45 の変更は...";

  it("存在する版数(過去分・最新分の両方)の見出しを検出できる", () => {
    // 前提固定: 合成テキストに2つの見出しが両方含まれていること(以降のアサーションが
    // 「常に false」の縮退実装でも通ってしまう空振りを避けるため、まず存在を保証する)。
    expect(doc).toContain("次の正式版が 1.2.0 である根拠");
    expect(doc).toContain("次の正式版が 1.2.1 である根拠");

    expect(hasVersionRationaleSection(doc, "1.2.0")).toBe(true);
    expect(hasVersionRationaleSection(doc, "1.2.1")).toBe(true);
  });

  it("正の対照: 存在しない版数(9.9.9)を渡すと見つからない(常に true を返す検出器を排除する)", () => {
    // m7 で実証された空振り(検出器を無害化しても偶然辻褄が合って緑になる)と同型の穴を
    // 塞ぐ。この検出器が「常に true を返す」縮退実装であっても、上のテストだけでは
    // 見抜けない。
    expect(hasVersionRationaleSection(doc, "9.9.9")).toBe(false);
  });

  it("部分一致誤判定を避ける(1.2.10 の見出しは 1.2.1 に一致しない)", () => {
    const docWithLongerVersion =
      "## 次の正式版が 1.2.10 である根拠(仮想の将来版)\n\n本文...";
    expect(hasVersionRationaleSection(docWithLongerVersion, "1.2.1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 配線テスト(実ファイルへの適用)
// ---------------------------------------------------------------------------

/** 本タスクが是正する対象の版数。次回の版数運用(公開1回につき1回上げる)で更新する。 */
const EXPECTED_APP_VERSION = "1.2.2";
/** packages/core は版数運用の対象外・据え置き(理由は docs/versioning.md 参照)。 */
const EXPECTED_CORE_VERSION = "0.2.0";

describe("配線: package.json のバージョン", () => {
  const rootPkg = JSON.parse(readNormalized(ROOT_PACKAGE_JSON_PATH)) as {
    version: string;
  };
  const appPkg = JSON.parse(readNormalized(APP_PACKAGE_JSON_PATH)) as {
    version: string;
  };
  const corePkg = JSON.parse(readNormalized(CORE_PACKAGE_JSON_PATH)) as {
    version: string;
  };

  it("root と app の version が一致している", () => {
    expect(versionsInSync(rootPkg.version, appPkg.version)).toBe(true);
  });

  it("root と app の version が 1.2.2(Issue #31: 到達経路の無い潜在的欠陥の是正)である", () => {
    // #44-D-1(このファイルの本来の対象)は 1.1.0 → 1.2.0、#45 が 1.2.1。本回は #31。
    // #31 は allocateBets の候補選定が「値として使えるか」を見ていなかった潜在的欠陥の
    // 是正で、placeOddsMin に非有限値が入る到達経路は現状無いため実データの数値は動かない。
    // 区分表の「分析結果の数値が変わる」に該当しないので patch。公開1回につき1回上げる
    // 運用により、EXPECTED_APP_VERSION 据え置きのままにならないことを固定する。
    expect(rootPkg.version).toBe(EXPECTED_APP_VERSION);
    expect(appPkg.version).toBe(EXPECTED_APP_VERSION);
  });

  it("root と app の version が X.Y.Z 形式(プレリリース識別子を含まない)である", () => {
    expect(isReleaseVersion(rootPkg.version)).toBe(true);
    expect(isReleaseVersion(appPkg.version)).toBe(true);
  });

  it("core の version は版数運用の対象外として 0.2.0 のまま据え置かれている", () => {
    // 誤って core まで一緒に上げてしまう事故を防ぐ(合意スコープ: core は対象外)。
    expect(corePkg.version).toBe(EXPECTED_CORE_VERSION);
  });
});

describe("配線: electron-builder.yml の artifactName(版数が exe 名に出る前提のピン留め)", () => {
  it("artifactName が keiba-ev-tool-${version}-portable.${ext} である", () => {
    const yml = readNormalized(ELECTRON_BUILDER_YML_PATH);
    const match = yml.match(/^\s*artifactName:\s*(.+)$/m);
    const captured = match?.[1];

    if (captured === undefined) {
      throw new Error("artifactName の定義行が見つかりません");
    }

    // ここがベタ書きの exe 名に変えられると、版数運用そのものと CI の孤児掃除ステップ
    // (現行ファイル名以外を削除する)の前提が静かに死ぬ。
    expect(captured.trim()).toBe(
      "keiba-ev-tool-${version}-portable.${ext}",
    );
  });
});

describe("配線: 文書中の版数表記が package.json と一致する", () => {
  // 対象ファイルと抽出パターンをここに明示列挙する(表記が消えても緑になる形骸化を防ぐため、
  // 各ロケーションで「パターンが1件も一致しなかったら失敗」を個別に固定する)。
  const appPkg = JSON.parse(readNormalized(APP_PACKAGE_JSON_PATH)) as {
    version: string;
  };
  const currentSpec = readNormalized(CURRENT_SPEC_PATH);
  const spec = readNormalized(SPEC_PATH);

  it("docs/current-spec.md に v接頭辞表記と裸表記の両方が package.json のバージョンと一致して現れる", () => {
    const mentions = extractVersionMentions(currentSpec, appPkg.version);

    // 空振り防止: 1件も一致しなければ失敗させる。
    expect(mentions.length).toBeGreaterThan(0);
    // 境界・異常系: v接頭辞つき表記(3行目相当)と裸表記(14行目相当)の両方が存在することを固定する。
    expect(mentions).toContain(`v${appPkg.version}`);
    expect(mentions).toContain(appPkg.version);
  });

  it("docs/current-spec.md のバージョン一覧に、core が版数運用の対象外である旨が併記されている", () => {
    // 合意スコープ 3: 「docs/current-spec.md:14 には core が版数運用の対象外である旨を添える」。
    // @keiba/core の版数表記の近傍(80文字以内)に「対象外」の語が現れることを確認する
    // (release-workflow-gate.test.ts の近接パターンと同じ考え方)。
    expect(currentSpec).toMatch(/@keiba\/core[\s\S]{0,80}対象外/);
  });

  it("keiba-ev-tool-spec.md に v接頭辞表記が package.json のバージョンと一致して現れる", () => {
    const mentions = extractVersionMentions(spec, appPkg.version);

    // 空振り防止: 1件も一致しなければ失敗させる。
    expect(mentions.length).toBeGreaterThan(0);
    expect(mentions).toContain(`v${appPkg.version}`);
  });
});

describe("配線: docs/versioning.md(版数運用規約)", () => {
  it("ファイルが存在し、規約の柱(区分表・上げる主体とタイミング・プレリリース不使用・core対象外・root/app一致・タグ命名)を含む", () => {
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(doc).toContain("major");
    expect(doc).toContain("minor");
    expect(doc).toContain("patch");
    expect(doc).toContain("[PUBLISH-APPROVED]");
    expect(doc).toContain("公開1回につき");
    expect(doc).toContain("プレリリース識別子");
    expect(doc).toContain("packages/core");
    expect(doc).toContain("v<package.json");
  });

  it("コミットメッセージの自動判定を採らない理由(日本語自由記述・誤判定の害)が記されている", () => {
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(doc).toMatch(/自動判定[\s\S]{0,200}(採らない|採用しない)/);
  });

  it("core を版数運用の対象外とする理由(private・npm未公開・workspace:* 参照)が記されている", () => {
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(doc).toContain("workspace:*");
    expect(doc).toMatch(/対象外[\s\S]{0,200}(private|npm)/);
  });

  it("次の正式版が 1.2.0 である根拠(機能追加あり・破壊的変更なし)が記されている", () => {
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(doc).toContain("1.2.0");
    expect(doc).toMatch(/(coerceSettings|ALTER TABLE)/);
  });

  it("EXPECTED_APP_VERSION に対応する『次の正式版が…である根拠』セクションが存在する(code-reviewer 一次レビュー 提案1の一般化採用)", () => {
    // literal な版数(例 "1.2.1")を直接ピン留めするのではなく、EXPECTED_APP_VERSION を
    // 介した汎用の不変条件にすることで、将来の版上げでは「根拠セクションを書く」ことが
    // 機械的に強制される(同時更新チェックリストの「意図的な摩擦」と同じ設計思想)。
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(hasVersionRationaleSection(doc, EXPECTED_APP_VERSION)).toBe(true);
  });

  it("正の対照: 実ファイルに対しても、存在しない版数(9.9.9)では根拠セクションが見つからない", () => {
    // 上のテストだけでは「常に true を返す検出器」を見抜けない(m7 と同型の空振り)。
    // 実ファイルに対しても陰性の対照を取ることで、純関数レベルの正の対照
    // (純関数: hasVersionRationaleSection の同名テスト)が実ファイルの配線でも
    // 効いていることを確認する。
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(hasVersionRationaleSection(doc, "9.9.9")).toBe(false);
  });

  it("workflow_dispatch による同一コミットの再送は「公開」に含めず、版数を上げない旨が明記されている(#44-D-1 のメタレビュー差し戻し 要修正1)", () => {
    // 差し戻し前は「頻度」条項が [PUBLISH-APPROVED] push と workflow_dispatch の両方を
    // 「公開」として扱っており、後者は同一コミットの再実行であるため版数を上げる余地が
    // そもそも無い(物理的に満たせない条項だった)。ここでは修正後の条項の中心語を
    // toContain の積み上げで固定する(言い換えへの脆さより、一度差し戻された条項という
    // 経緯を踏まえた検出力を優先する)。
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(doc).toContain("workflow_dispatch");
    expect(doc).toContain("「公開」に含めない");
    expect(doc).toMatch(/版数は上げない/);
  });

  it("D-2(#45)の機械検査でも workflow_dispatch を版数据え置き検査から除外する予定である旨が記されている(次タスクへの申し送り)", () => {
    // D-1(本書)と D-2(#45 の機械検査)の間で「workflow_dispatch をどう扱うか」の認識が
    // ずれると、D-2 の実装者が本書を仕様として読んだときに手戻りが起きる(差し戻し要修正1の
    // 指摘そのもの)。D-2 への申し送りが本書に残っていることを固定する。
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(doc).toMatch(/D-2[\s\S]{0,60}workflow_dispatch[\s\S]{0,60}除外/);
  });

  it("版数を上げるときの同時更新チェックリストが、不変条件テストが実際にピン留めしている全箇所を列挙している(#44-D-1 のメタレビュー差し戻し 要修正2)", () => {
    // 「操作者が読むのは docs/versioning.md と CLAUDE.md であり、本テストファイルのコメントは
    // 読まれない」という指摘(要修正2)への対応。EXPECTED_APP_VERSION というテスト内部の
    // 定数名まで含めて列挙することで、「pnpm test が落ちたら何を更新し忘れたか」を
    // 操作者向け文書だけから辿れることを固定する。
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(doc).toContain("同時更新チェックリスト");
    // 6項目のうち、複数箇所を1つの toContain で束ねると「片方が消えても緑」という穴が残る
    // (メタレビュー提案)。root/app の package.json、docs/current-spec.md の2箇所
    // (冒頭・バージョン一覧行)、keiba-ev-tool-spec.md、EXPECTED_APP_VERSION を個別に固定する。
    // 各固定文字列は文書内で一意である(出現回数=1)ことを実測して選定した
    // (「packages/app/package.json」単体は背景・チェックリスト・core対象外理由の3箇所に
    // 出現し項目を丸ごと削除しても緑のままになる穴があったため、チェックリストの当該行
    // 「`packages/app/package.json` の `version`」でのみ一意に一致する部分文字列に直した)。
    expect(doc).toContain("root `package.json`");
    expect(doc).toContain("`packages/app/package.json` の `version`");
    expect(doc).toContain("実際に実装されている現状(vX.Y.Z)");
    expect(doc).toContain("バージョン: ルート/アプリ");
    expect(doc).toContain("keiba-ev-tool-spec.md");
    expect(doc).toContain("EXPECTED_APP_VERSION");
    // 「テストの失敗ではなく更新漏れの検出である」という読み方そのものを明示していること。
    expect(doc).toMatch(/更新漏れ.{0,20}(検出|正しく)/);
  });

  it("同時更新チェックリストの7項目目として、版数根拠セクションの追加が明記されている(code-reviewer 一次レビュー 提案1対応)", () => {
    // 対応2: 汎用の不変条件(hasVersionRationaleSection)を追加したことで、
    // 「版を上げたら根拠セクションを書く」ことが新たにチェックリスト上も要求される。
    // これを明記しないと、機械検査だけが先行してチェックリスト本文と食い違う
    // (チェックリストを見ても7項目目の存在に気づけない)。
    const doc = readNormalized(VERSIONING_DOC_PATH);

    expect(doc).toContain("7. ");
    expect(doc).toContain("次の正式版が");
    expect(doc).toMatch(/7\.[\s\S]{0,80}根拠セクション/);
  });
});

describe("配線: CLAUDE.md からの参照", () => {
  it("ドキュメント一覧に docs/versioning.md への参照が1行追加されている", () => {
    const claudeMd = readNormalized(path.join(REPO_ROOT, "CLAUDE.md"));

    expect(claudeMd).toContain("docs/versioning.md");
  });
});
