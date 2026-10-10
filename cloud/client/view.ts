/**
 * 画面の VNode(Issue #184。純関数)。表示用データ(`list.ts`・`race.ts`〈#185〉・`result.ts`〈#185〉)を、DOM に依存しない木にする。
 * 文字列の子は、アダプタ(`dom.ts`)がテキストノードにする(外から来た文字列が HTML として解釈されない)。
 * Issue #188: 発走前のカードの中に最新の分析の結果を出す。馬ごと・配分の部分は結果画面と共通の `resultSections`(見出しの階層だけ違う)。
 * #185 で足した画面は、#184 の要素・属性の許可リスト(`dom.ts`)の範囲だけで組む(新しい要素・属性は足していない。一覧は `ul`、強調は class と文字)。
 */
import type { TaskMode } from "./api";
import type { BulkModel, BulkPanel } from "./bulk";
import type { Badge, ListModel, RaceGroupItem, RaceItem } from "./list";
import type { CardResult, RaceModel, TaskCard } from "./race";
import { ACTUAL_HIGHER_MARK, FAIR_WIN_ODDS_LABEL, LABEL_ADJUSTED_PROB, LABEL_CONCERNS, LABEL_HIGHLIGHTS, LABEL_PRIOR, type HorseCard, type MarkedHorse, type ResultContent, type ResultModel, type TopProbHorse } from "./result";
import type { BackfillView, CheckView, MigrationModel, ProgressView } from "./migration-model";
import type { FieldModel, PreviewModel, SettingsModel, WeightsModel } from "./settings-form";
import type { StatRow, StatSection, VerifyModel, VerifyNotice, VersionCard, VersionsSection } from "./verify-model";
import type { VerifyVenue } from "./api-verify";
import type { RaceRowView, ReportBodyView, ReportModel } from "./report-model";
import type { AdminOnlyModel } from "./admin-only";
import { h, type PickedFile, type VNode } from "./vnode";

export interface ViewActions {
  /** 日付の入力欄の値(YYYY-MM-DD。空・不正なこともある)。 */
  readonly onDateChange: (value: string) => void;
  readonly onRefresh: () => void;
  /** 場の見出しのタップ(Issue #187)。`open` は押したあとの状態(今の逆)。 */
  readonly onToggleGroup: (key: string, open: boolean) => void;
  /** 発走前のカードの結果の見出しのタップ(Issue #188)。引数は見出しの `data-date`・`data-race` と同じ値。`open` は押したあとの状態(今の逆)。 */
  readonly onToggleResult: (date: string, raceId: string, open: boolean) => void;
  /** 起動のボタン(Issue #186)。引数(開催日・レース・モード)は、ボタンの `data-*` と同じ値。 */
  readonly onRun: (date: string, raceId: string, mode: TaskMode) => void;
  /** 場ごとの一括実行のボタン(Issue #251)。引数(場のキー・モード)は、ボタンの `data-key`・`data-mode` と同じ値。押すと確認画面を開く。 */
  readonly onBulkOpen: (groupKey: string, mode: TaskMode) => void;
  /** 一括実行の確認画面の「実行する」(Issue #251)。引数(場のキー)は `data-key` と同じ値。 */
  readonly onBulkGo: (groupKey: string) => void;
  /** 一括実行の確認画面の「やめる」・結果の「閉じる」(Issue #251)。引数(場のキー)は `data-key` と同じ値。 */
  readonly onBulkDismiss: (groupKey: string) => void;
  /** 追跡の停止の注記の「状態を更新」(Issue #186)。 */
  readonly onRetrack: () => void;
  /** 設定の入力欄の変更(Issue #189)。`key` は入力欄の `data-field` と同じ項目名。真偽の欄は `"true"`・`"false"`。**下書きを書くだけで再描画しない**(`app.ts`)。 */
  readonly onSettingsInput: (key: string, value: string) => void;
  /** 設定の「保存」ボタン(Issue #189)。引数なし(入力は下書きから読む)。 */
  readonly onSettingsSave: () => void;
  /** プロンプトのプレビューの開閉のボタン(Issue #201)。`open` は押したあとの状態(今の逆)。 */
  readonly onSettingsPreviewToggle: (open: boolean) => void;
  /** プロンプトのプレビューの「入力中の内容を反映」ボタン(Issue #201。開いているときだけ出る)。引数なし。 */
  readonly onSettingsPreviewRefresh: () => void;
  /** 「重みを既定値に戻す」(Issue #218): 下書きの重み13項目だけを既定値に戻す(保存はしない)。 */
  readonly onSettingsWeightsReset: () => void;
  /** 移行画面のファイル選択(Issue #222)。選ばれた File(選択が空なら null)。 */
  readonly onMigrationFile: (file: PickedFile | null) => void;
  /** 移行画面の「取り込みを始める」(Issue #222)。引数なし(検証したファイルは `migration-screen.ts` が持つ)。 */
  readonly onMigrationStart: () => void;
  /** 移行画面の検証の取り消し(Issue #222)。 */
  readonly onMigrationCancelCheck: () => void;
  /** 検証画面の区分の切替(Issue #219）。 */
  readonly onVerifyVenue: (venue: VerifyVenue) => void;
  /** 検証画面の版別キャリブレーションの開閉(Issue #220)。`key` は版のキー、`open` は押したあとの状態。 */
  readonly onVerifyVersionToggle: (key: string, open: boolean) => void;
  /** 日報画面の「この日の日報を作る」ボタン(Issue #235)。引数なし(表示中の日は `report-screen.ts` が持つ)。 */
  readonly onReportRun: () => void;
}

function badge(prefix: string, b: Badge): VNode {
  return h("span", { class: `badge ${b.tone}` }, [`${prefix}: ${b.label}`]);
}

function raceRow(item: RaceItem): VNode {
  const head = h("span", { class: "race-head" }, [h("strong", {}, [item.label]), h("span", { class: "race-name" }, [item.name]), ...(item.grade === null ? [] : [h("span", { class: "grade" }, [item.grade])])]);
  const detail = h("span", { class: "race-detail" }, [item.detail]);
  const badges = item.badges === null ? [] : [h("span", { class: "badges" }, [badge("事前", item.badges.morning), badge("発走前", item.badges.preRace)])];
  return h("li", {}, [h("a", { class: "race", href: item.href }, [head, detail, ...badges])]);
}

/**
 * 見出しの文字(開閉が色だけに頼らず分かるよう ▾/▸ を付ける)。例: 「▸ 大井・実行中 3・失敗 1」。0 の項目と、板が無いときの要約は出さない(板が無ければ「▸ 大井」だけ)。
 * レース数(`12R`)は出さない(Issue #186。ユーザーの依頼「『12R』という表記は不要」)。
 */
function groupHeadingText(group: RaceGroupItem): string {
  const parts = [`${group.open ? "▾" : "▸"} ${group.name}`];
  if (group.summary !== null) {
    if (group.summary.running > 0) parts.push(`実行中 ${group.summary.running}`);
    if (group.summary.failed > 0) parts.push(`失敗 ${group.summary.failed}`);
  }
  return parts.join("・");
}

/**
 * 場のまとまり。見出しは h2 の中のボタン(`<details>` は使わない=描画のたびに DOM を作り直すので、開閉の状態を DOM に持てない)。閉じた場のレースの行は作らない。
 * **クリック処理に渡すキーは `data-key` にも出す**(Issue #186。`createMounter` は JSON が同じ木の DOM を触らない=関数は比較されないので、引数が木に出ていないと古い処理が残る)。
 */
function bulkPanel(key: string, panel: BulkPanel, actions: ViewActions): VNode {
  switch (panel.kind) {
    case "confirm":
      return h("div", { class: "bulk-panel", role: "group", "aria-label": panel.title }, [
        h("h3", {}, [panel.title]),
        h("ul", { class: "bulk-lines" }, panel.lines.map((line) => h("li", {}, [line]))),
        ...(panel.notes.length === 0 ? [] : [h("ul", { class: "bulk-notes" }, panel.notes.map((note) => h("li", { class: "bulk-note-line notice" }, [note])))]),
        h("div", { class: "bulk-actions" }, [
          h("button", { class: "bulk-go", "data-key": key, "data-mode": panel.mode }, [panel.goLabel], { click: () => actions.onBulkGo(key) }),
          h("button", { class: "bulk-cancel", "data-key": key }, [panel.cancelLabel], { click: () => actions.onBulkDismiss(key) }),
        ]),
      ]);
    case "sending":
      return h("p", { class: "bulk-sending notice", role: "status" }, [panel.text]);
    case "result":
      return h("div", { class: `bulk-result notice${panel.tone === "error" ? " error" : ""}`, role: panel.tone === "error" ? "alert" : "status" }, [
        h("p", {}, [panel.text]),
        h("button", { class: "bulk-close", "data-key": key }, ["閉じる"], { click: () => actions.onBulkDismiss(key) }),
      ]);
  }
}

/** 場ごとの一括実行(Issue #251。管理者だけ=閲覧者は `bulk` が null で呼ばれない)。ボタン 2 つ・無効の理由・確認画面/送信中/結果。 */
function bulkSection(key: string, bulk: BulkModel, actions: ViewActions): VNode {
  return h("div", { class: "bulk", "data-key": key }, [
    h(
      "div",
      { class: "bulk-buttons" },
      bulk.buttons.map((b) => h("button", { class: "bulk-run", disabled: b.disabled, "data-key": key, "data-mode": b.mode }, [b.label], { click: () => actions.onBulkOpen(key, b.mode) })),
    ),
    ...(bulk.note === null ? [] : [h("p", { class: "bulk-note meta" }, [bulk.note])]),
    ...(bulk.panel === null ? [] : [bulkPanel(key, bulk.panel, actions)]),
  ]);
}

function venueSection(group: RaceGroupItem, actions: ViewActions): VNode {
  const toggle = h("button", { class: "venue-toggle", "aria-expanded": group.open ? "true" : "false", "data-key": group.key }, [groupHeadingText(group)], { click: () => actions.onToggleGroup(group.key, !group.open) });
  // 一括実行(Issue #251)は、場を開いているときだけ、見出しとレースの一覧の間に置く(管理者だけ=閲覧者は group.bulk が null)。
  const bulk = group.open && group.bulk !== null ? [bulkSection(group.key, group.bulk, actions)] : [];
  return h("section", { class: "venue" }, [h("h2", {}, [toggle]), ...bulk, ...(group.open ? [h("ul", { class: "races" }, group.races.map(raceRow))] : [])]);
}

/** 追跡の停止の注記と「状態を更新」(Issue #186)。止まっていないとき(null)は何も出さない。 */
function trackingNotice(message: string | null, actions: ViewActions): VNode[] {
  if (message === null) return [];
  return [h("div", { class: "tracking" }, [h("p", { class: "notice" }, [message]), h("button", { class: "retrack" }, ["状態を更新"], { click: actions.onRetrack })])];
}

function listScreen(model: ListModel, actions: ViewActions): VNode {
  const controls = h("div", { class: "controls" }, [
    h("label", { class: "date" }, [h("span", {}, ["開催日"]), h("input", { type: "date", value: model.dateInput }, [], { change: actions.onDateChange })]),
    h(
      "nav",
      { class: "tabs", "aria-label": "中央・地方" },
      model.venueTabs.map((t) => h("a", { class: "tab", href: t.href, "aria-current": t.current ? "page" : undefined }, [t.label])),
    ),
    h("button", { class: "refresh", disabled: model.loading }, [model.loading ? "読み込み中…" : "更新"], { click: actions.onRefresh }),
    // 検証・設定への入口は管理者だけ(Issue #238。閲覧者は href が null)。日報は閲覧者にも出す。
    ...(model.verifyHref === null ? [] : [h("a", { class: "verify-link", href: model.verifyHref }, ["検証"])]),
    h("a", { class: "report-link", href: model.reportHref }, ["日報"]),
    ...(model.settingsHref === null ? [] : [h("a", { class: "settings-link", href: model.settingsHref }, ["設定"])]),
  ]);
  const notices: VNode[] = [];
  if (model.error !== null) {
    notices.push(h("p", { class: "notice error", role: "alert" }, [model.error]));
  }
  if (model.boardNotice !== null) {
    notices.push(h("p", { class: "notice" }, [model.boardNotice]));
  }
  const body: VNode[] = [];
  if (model.empty) {
    body.push(h("p", { class: "empty" }, ["この日・この区分の開催はありません。"]));
  }
  for (const group of model.groups) {
    body.push(venueSection(group, actions));
  }
  return h("div", { class: "screen" }, [controls, ...trackingNotice(model.tracking, actions), ...notices, ...body]);
}

const loadingLabel = (loading: boolean, label: string): string => (loading ? "読み込み中…" : label);

function priorRow(item: { rank: number; umaban: number; name: string | null; value: string }): VNode {
  return h("li", { class: "prior-row" }, [
    h("strong", {}, [`${item.rank}位`]),
    h("span", {}, [`${item.umaban}番`]),
    ...(item.name === null ? [] : [h("span", { class: "horse-name" }, [item.name])]),
    h("span", {}, [`3着内率 ${item.value}`]),
  ]);
}

/**
 * 起動のボタンは、クリック処理に渡す値(開催日・レース・モード)を `data-*` にも出す(`createMounter` は JSON が同じ木の DOM を触らない=関数は比較されない。
 * 引数が木に出ていないと、レースを移っても古い処理が残る)。`client-view.test.ts` が、処理を持つ要素に `data-*` があること(引数なしの処理を除く)を機械的に固定する。
 */
function runButton(button: NonNullable<TaskCard["button"]>, actions: ViewActions): VNode {
  return h(
    "button",
    { class: "run", disabled: button.disabled, "data-date": button.date, "data-race": button.raceId, "data-mode": button.mode },
    [button.label],
    { click: () => actions.onRun(button.date, button.raceId, button.mode) },
  );
}

/** 見出しの文字(開閉が色だけに頼らず分かるよう ▾/▸ を付ける)。 */
const resultHeadingText = (open: boolean): string => `${open ? "▾" : "▸"} 分析の結果`;

/**
 * 発走前のカードの結果(Issue #188)。読み込み中・失敗は開閉に関係なく出す。開閉の見出しは ready のときだけ(`h3` の中のボタン。`<details>` は使わない=#187 と同じ理由)。
 * **クリック処理に渡す値は `data-date`・`data-race` にも出す**(`createMounter` は JSON が同じ木の DOM を触らない=関数は比較されない)。
 */
function cardResult(result: CardResult, actions: ViewActions): VNode {
  if (result.kind === "loading") {
    return h("p", { class: "card-note" }, ["結果を読み込み中…"]);
  }
  if (result.kind === "error") {
    return h("p", { class: "card-error", role: "alert" }, [`${result.message}(「更新」で再取得できます)`]);
  }
  const { content, open, date, raceId } = result;
  const toggle = h(
    "button",
    { class: "result-toggle", "aria-expanded": open ? "true" : "false", "data-date": date, "data-race": raceId },
    [resultHeadingText(open)],
    { click: () => actions.onToggleResult(date, raceId, !open) },
  );
  return h("section", { class: "card-result" }, [
    h("h3", {}, [toggle]),
    ...(open
      ? [
          ...resultMeta(content),
          ...resultSections(content, "h3"),
        ]
      : []),
  ]);
}

function taskCard(card: TaskCard, actions: ViewActions): VNode {
  return h("section", { class: "card" }, [
    h("h2", {}, [card.title]),
    h("span", { class: `badge ${card.badge.tone}` }, [card.badge.label]),
    h("p", { class: "card-desc" }, [card.description]),
    ...(card.error === null ? [] : [h("p", { class: "card-error" }, [card.error])]),
    ...(card.runError === null ? [] : [h("p", { class: "card-error", role: "alert" }, [card.runError])]),
    ...(card.runInfo === null ? [] : [h("p", { class: "card-note" }, [card.runInfo])]),
    ...(card.priorNotice === null ? [] : [h("p", { class: "card-note" }, [card.priorNotice])]),
    ...(card.prior === null ? [] : [h("ul", { class: "prior" }, card.prior.map(priorRow))]),
    ...(card.result === null ? [] : [cardResult(card.result, actions)]),
    // 起動のボタンは管理者だけ(Issue #238。閲覧者は null)。
    ...(card.button === null ? [] : [runButton(card.button, actions)]),
  ]);
}

function raceScreen(model: RaceModel, actions: ViewActions): VNode {
  const controls = h("div", { class: "controls" }, [
    h("a", { class: "back", href: model.backHref }, ["一覧へ戻る"]),
    h("button", { class: "refresh", disabled: model.loading }, [loadingLabel(model.loading, "更新")], { click: actions.onRefresh }),
  ]);
  const body: VNode[] = [];
  if (model.statusNotice !== null) {
    body.push(h("p", { class: "notice error", role: "alert" }, [model.statusNotice]));
  } else if (model.cards === null) {
    body.push(h("p", { class: "empty" }, ["状態を読み込み中…"]));
  } else {
    body.push(...model.cards.map((card) => taskCard(card, actions)));
  }
  const past = model.past;
  const pastBody: VNode[] = [];
  if (past.kind === "loading") {
    pastBody.push(h("p", { class: "empty" }, ["読み込み中…"]));
  } else if (past.kind === "error") {
    pastBody.push(h("p", { class: "notice error", role: "alert" }, [past.message]));
  } else if (past.items.length === 0) {
    pastBody.push(h("p", { class: "empty" }, ["過去の分析はありません。"]));
  } else {
    pastBody.push(h("ul", { class: "past" }, past.items.map((item) => h("li", {}, [h("a", { class: "past-link", href: item.href }, [item.label])]))));
  }
  return h("div", { class: "screen" }, [controls, ...trackingNotice(model.tracking, actions), h("h1", { class: "title" }, [model.title]), ...body, h("section", { class: "past-section" }, [h("h2", {}, ["過去の分析"]), ...pastBody])]);
}

/**
 * 結果の見出しの下(結果画面と、発走前のカードの中で共通。Issue #195): 分析時刻・分析モデル・LLM を使わなかった理由(`llmNote`。モデルの有無に関係なく、null でなければ)・詳細の注記。
 * 理由は「分析モデル」の行のすぐ下(モデル欄の近く)に置く。Issue #198: LLM の所要時間・usage(記録があるとき)は、モデルの行と理由の間。
 */
function resultMeta(content: ResultContent): VNode[] {
  return [
    h("p", { class: "meta" }, [`分析時刻: ${content.analyzedAt}`]),
    h("p", { class: "meta" }, [`分析モデル: ${content.model}`]),
    // LLM の所要時間・usage(Issue #198)。要約の1行と、該当するときだけの警告(1件ずつ)。理由の注記より上。
    ...(content.llmUsage === null ? [] : [h("p", { class: "meta llm-usage" }, [content.llmUsage.summary]), ...content.llmUsage.warnings.map((w) => h("p", { class: "notice llm-usage-warn" }, [w]))]),
    ...(content.llmNote === null ? [] : [h("p", { class: "notice llm-note" }, [content.llmNote])]),
    ...(content.detailNote === null ? [] : [h("p", { class: "notice" }, [content.detailNote])]),
  ];
}

/** 強調材料・懸念事項の1つの塊(Issue #198)。ラベルと箇条書き(`ul` > `li`)。項目は外から来た文字列(子の文字列は、アダプタがテキストノードにする)。空の側は呼び出し側が出さない。 */
function pointsBlock(kind: "highlights" | "concerns", label: string, items: readonly string[]): VNode {
  return h("div", { class: `horse-points ${kind}` }, [h("span", { class: "points-label" }, [label]), h("ul", { class: "points-list" }, items.map((item) => h("li", {}, [item])))]);
}

function horseCard(horse: HorseCard): VNode {
  return h("li", { class: horse.positive ? "horse positive" : "horse" }, [
    h("span", { class: "horse-head" }, [
      h("strong", {}, [`${horse.umaban}`]),
      ...(horse.name === null ? [] : [h("span", { class: "horse-name" }, [horse.name])]),
      ...(horse.mark === null ? [] : [h("span", { class: "mark" }, [horse.mark])]),
    ]),
    h("span", { class: "horse-line" }, [`${LABEL_PRIOR} ${horse.prior}`]),
    // 補正後の3着内率は LLM が効いたときだけ(LLM なしでは 3着内率と同じ値になるので出さない。EV は LLM が効いたとき補正後の確率から計算される)。
    ...(horse.adjusted === null ? [] : [h("span", { class: "horse-line" }, [`${LABEL_ADJUSTED_PROB} ${horse.adjusted}`])]),
    h("span", { class: "horse-line" }, [`複勝オッズ下限 ${horse.odds}`]),
    h("span", { class: "horse-line" }, [`EV ${horse.ev}`, ...(horse.positive ? [h("strong", { class: "ev-plus" }, ["EVプラス"])] : [])]),
    // 単勝の想定(目安)と実際(Issue #247)。実際が想定より高いときは文字で示す(色に頼らない)。欠損は「-」。
    h("span", { class: "horse-line win-odds" }, [
      `単勝 ${FAIR_WIN_ODDS_LABEL} ${horse.winOdds.fair} / ${horse.winOdds.actualLabel} ${horse.winOdds.actual}`,
      ...(horse.winOdds.higher ? [h("strong", { class: "odds-higher" }, [ACTUAL_HIGHER_MARK])] : []),
    ]),
    ...(horse.reason === null ? [] : [h("span", { class: "horse-reason" }, [`根拠 ${horse.reason}`])]),
    // 根拠の下に、強調材料・懸念事項(LLM が効いたときだけ中身がある。空の側は塊ごと出さない)。
    ...(horse.highlights.length === 0 ? [] : [pointsBlock("highlights", LABEL_HIGHLIGHTS, horse.highlights)]),
    ...(horse.concerns.length === 0 ? [] : [pointsBlock("concerns", LABEL_CONCERNS, horse.concerns)]),
  ]);
}

/** 印の付いた馬の1行(Issue #211)。印・馬番・馬名。馬名が無ければ印と馬番だけ。数値は出さない。 */
function markedHorseRow(m: MarkedHorse): VNode {
  return h("li", { class: "marked" }, [
    h("span", { class: "marked-mark" }, [m.mark]),
    // 要素の間の隙間は、空白のテキストノードで作る(`.marked` に CSS は無く、`dom.ts` は子をそのまま appendChild する。無いと実ブラウザでは「◎3エートラックス」と詰まる)。
    " ",
    h("strong", {}, [`${m.umaban}`]),
    ...(m.name === null ? [] : [" ", h("span", { class: "marked-name" }, [m.name])]),
  ]);
}

/** 3着内率の上位5頭の1行(Issue #240)。馬番・馬名・率・印。馬名・印が無ければ省く。 */
function topProbRow(r: TopProbHorse): VNode {
  return h("li", { class: "top-prob" }, [
    h("strong", {}, [`${r.umaban}`]),
    // 要素の間の隙間は、空白のテキストノードで作る(印の付いた馬の行と同じ理由。無いと実ブラウザでは「5エコー45.0%◎」と詰まる)。
    ...(r.name === null ? [] : [" ", h("span", { class: "top-prob-name" }, [r.name])]),
    " ",
    h("span", { class: "top-prob-rate" }, [r.rate]),
    ...(r.mark === null ? [] : [" ", h("span", { class: "top-prob-mark" }, [r.mark])]),
  ]);
}

/**
 * 結果の「印の付いた馬」(Issue #211。「馬ごとの評価」より前)・「3着内率の上位5頭」(Issue #240。印の付いた馬の直後)・「馬ごとの評価」・「配分の提案」(結果画面と、レース画面の発走前のカード〈Issue #188〉で共通。重複して実装しない)。
 * `heading` は見出しの要素(結果画面は h2、カードの中はカードの見出し h2 の下なので h3)。
 */
function resultSections(content: ResultContent, heading: "h2" | "h3"): VNode[] {
  const allocation = content.allocation;
  return [
    // 印の付いた馬(Issue #211)。印が1頭も無ければ section ごと出さない。凡例はここ(見出しの下)に1回だけ(「馬ごとの評価」の中には出さない)。
    ...(content.markedHorses.length === 0
      ? []
      : [
          h("section", { class: "marked-horses" }, [
            h(heading, {}, ["印の付いた馬"]),
            ...(content.markLegend === null ? [] : [h("p", { class: "meta mark-legend" }, [content.markLegend])]),
            h("ul", { class: "horse-list" }, content.markedHorses.map(markedHorseRow)),
          ]),
        ]),
    // 3着内率の上位5頭(Issue #240)。印の有無と独立。率が有限な馬が1頭も無ければ section ごと出さない。凡例は足さない(印の付いた馬の凡例が1回出ている)。
    ...(content.topProbs === null ? [] : [h("section", { class: "top-probs" }, [h(heading, {}, [content.topProbs.heading]), h("ul", { class: "horse-list" }, content.topProbs.rows.map(topProbRow))])]),
    h("section", { class: "horses" }, [
      h(heading, {}, ["馬ごとの評価"]),
      // 単勝の想定の説明文(Issue #247)。カードごとには出さず、見出しの下に1回。
      ...(content.winOddsNote === null ? [] : [h("p", { class: "meta win-odds-note" }, [content.winOddsNote])]),
      h("ul", { class: "horse-list" }, content.horses.map(horseCard)),
    ]),
    h("section", { class: "allocation" }, [
      h(heading, {}, ["配分の提案(分析時点)"]),
      ...allocation.notices.map((n) => h("p", { class: "notice" }, [n])),
      ...(allocation.bets.length === 0
        ? []
        : [
            h(
              "ul",
              { class: "bets" },
              allocation.bets.map((b) =>
                h("li", { class: "bet" }, [h("strong", {}, [b.betTypeLabel]), h("span", {}, [b.comboLabel]), h("span", {}, [b.stake]), h("small", {}, [`オッズ ${b.odds}・EV ${b.ev}`])]),
              ),
            ),
          ]),
      ...(allocation.settingsRows.length === 0 ? [] : [h("ul", { class: "settings" }, allocation.settingsRows.map((r) => h("li", {}, [h("small", {}, [r])])))]),
    ]),
  ];
}

function resultScreen(model: ResultModel, actions: ViewActions): VNode {
  const controls = h("div", { class: "controls" }, [
    h("a", { class: "back", href: model.backHref }, ["戻る"]),
    ...(model.error === null ? [] : [h("button", { class: "refresh" }, ["更新"], { click: actions.onRefresh })]),
  ]);
  const body: VNode[] = [];
  if (model.loading) {
    body.push(h("p", { class: "empty" }, ["読み込み中…"]));
  }
  if (model.error !== null) {
    body.push(h("p", { class: "notice error", role: "alert" }, [model.error]));
  }
  const content = model.content;
  if (content !== null) {
    body.push(h("h1", { class: "title" }, [content.title]));
    body.push(...resultMeta(content));
    body.push(...resultSections(content, "h2"));
  }
  return h("div", { class: "screen" }, [controls, ...body]);
}

/**
 * 設定の1項目(Issue #189)。入力欄は `data-field` に項目名を持ち(`createMounter` は JSON が同じ木の DOM を触らない=関数は比較されないので、引数を木に出す)、変更は `onSettingsInput(項目名, 値)`。
 * ラベルが入力欄を包む(id を使わない)。エラーは項目の近くに `role="alert"`、入力欄に `aria-invalid`。補助文は小さい文字。
 */
function settingsField(field: FieldModel, actions: ViewActions): VNode {
  const common = { "data-field": field.key, disabled: field.disabled, "aria-invalid": field.error === null ? undefined : "true" };
  const onValue = (value: string): void => actions.onSettingsInput(field.key, value);
  // 文字を打つ欄(text・textarea)は、`input`(打つたび)でも下書きを書く。**change は blur で発火する**ので、フォーカスがあるまま「保存」をタップして click が先に届くと、直前の入力を取りこぼす。
  // どちらも下書きを書くだけで再描画しない(`app.ts`)。checkbox・select は選んだ時点で change が届く。
  const on = { change: onValue };
  const onTyped = { change: onValue, input: onValue };
  let control: VNode;
  switch (field.kind) {
    case "checkbox":
      control = h("input", { ...common, type: "checkbox", checked: field.value === true }, [], on);
      break;
    case "textarea":
      control = h("textarea", { ...common, value: String(field.value), ...(field.maxlength === null ? {} : { maxlength: field.maxlength }) }, [], onTyped);
      break;
    case "select":
      control = h("select", { ...common, value: String(field.value) }, (field.options ?? []).map((o) => h("option", { value: o.value }, [o.label])), on);
      break;
    case "text":
      control = h("input", { ...common, type: "text", value: String(field.value), ...(field.inputmode === null ? {} : { inputmode: field.inputmode }) }, [], onTyped);
      break;
  }
  const label =
    field.kind === "checkbox"
      ? h("label", { class: "field-check" }, [control, h("span", {}, [field.label])])
      : h("label", { class: "field-label" }, [h("span", { class: "field-name" }, [field.label]), control]);
  return h("div", { class: "field" }, [
    label,
    ...(field.help === null ? [] : [h("p", { class: "field-help" }, [field.help])]),
    ...(field.error === null ? [] : [h("p", { class: "field-error", role: "alert" }, [field.error])]),
  ]);
}

/**
 * プロンプトのプレビュー(Issue #201)。開閉は `h3` の中のボタン(`<details>` は使わない=#187・#188 と同じ理由)。文面は `div`(許可リストに `pre` は無い)に、改行を含む文字列を
 * 1 つのテキストノードとして入れる(改行・折り返しは CSS の `white-space: pre-wrap`。外から来た追加指示も HTML として解釈されない)。内側のスクロールは付けない(スマホで操作しづらいため。ページのスクロールに任せる)。
 */
function previewSection(preview: PreviewModel, saving: boolean, actions: ViewActions): VNode {
  const toggle = h(
    "button",
    // クリック処理に渡す値(押したあとの状態)は `data-open-after` にも出す(`createMounter` は JSON が同じ木の DOM を触らない=関数は比較されないので、引数を木に出す。`result-toggle` と同じ)。
    { class: "preview-toggle", "aria-expanded": preview.open ? "true" : "false", "data-open-after": preview.open ? "false" : "true", disabled: saving },
    [preview.toggleLabel],
    { click: () => actions.onSettingsPreviewToggle(!preview.open) },
  );
  const opened =
    preview.open && preview.text !== null
      ? [
          ...preview.notes.map((note) => h("p", { class: "preview-note" }, [note])),
          ...(preview.refreshLabel === null ? [] : [h("button", { class: "preview-refresh", disabled: saving }, [preview.refreshLabel], { click: actions.onSettingsPreviewRefresh })]),
          h("div", { class: "prompt-preview" }, [preview.text]),
        ]
      : [];
  return h("section", { class: "preview" }, [h("h3", {}, [toggle]), ...opened]);
}

/**
 * スコアリングの重みの節(Issue #218)。見出し(h2)・説明・小見出し(h3)ごとの入力欄(通常の項目と同じ部品 `settingsField`)・「重みを既定値に戻す」ボタン。
 * 開閉はしない(常に表示。`<details>` は使わない=#187・#188 と同じ理由。状態も増やさない)。スマホ幅では、入力欄は通常の項目と同じ縦並び(幅 100%・高さ 44px 以上)。
 */
function weightsSection(weights: WeightsModel, actions: ViewActions): VNode {
  return h("section", { class: "weights" }, [
    h("h2", {}, [weights.heading]),
    ...weights.help.map((line) => h("p", { class: "weights-help" }, [line])),
    ...weights.groups.map((group) => h("div", { class: "weights-group" }, [h("h3", {}, [group.heading]), ...group.fields.map((f) => settingsField(f, actions))])),
    h("button", { class: "weights-reset", disabled: weights.resetDisabled }, [weights.resetLabel], { click: actions.onSettingsWeightsReset }),
  ]);
}

function settingsScreen(model: SettingsModel, actions: ViewActions): VNode {
  const controls = h("div", { class: "controls" }, [
    h("a", { class: "back", href: model.backHref }, ["一覧へ戻る"]),
    h("button", { class: "refresh", disabled: model.loading || model.saving }, [model.loading ? "読み込み中…" : "再読込"], { click: actions.onRefresh }),
  ]);
  const body: VNode[] = [];
  if (model.loading) {
    body.push(h("p", { class: "empty" }, ["読み込み中…"]));
  }
  if (model.error !== null) {
    body.push(h("p", { class: "notice error", role: "alert" }, [model.error]));
  }
  if (model.sourceNote !== null) {
    body.push(h("p", { class: "notice" }, [model.sourceNote]));
  }
  if (model.fields.length > 0) {
    body.push(h("p", { class: "meta" }, ["保存した設定は、次に実行する発走前の分析から使われます(実行中の分析は、始めたときの設定のままです)。"]));
    body.push(...model.fields.map((f) => settingsField(f, actions)));
    if (model.weights !== null) {
      body.push(weightsSection(model.weights, actions));
    }
    body.push(h("button", { class: "settings-save", disabled: model.saving }, [model.saving ? "保存中…" : "保存"], { click: actions.onSettingsSave }));
    if (model.saveNotice !== null) {
      body.push(
        model.saveNotice.tone === "error"
          ? h("p", { class: "notice error", role: "alert" }, [model.saveNotice.text])
          : h("p", { class: "notice" }, [model.saveNotice.text]),
      );
    }
    if (model.preview !== null) {
      body.push(previewSection(model.preview, model.saving, actions));
    }
  }
  body.push(migrationSection(model.migration));
  return h("div", { class: "screen" }, [controls, h("h1", { class: "title" }, ["設定"]), ...body]);
}

/** 設定画面の「exe から移行」の節(Issue #222)。要点とリンクだけ(詳細・操作は別画面 `#migration`。設定フォームの入力を移行の再描画から切り離す)。取得の失敗でも出す。 */
function migrationSection(section: SettingsModel["migration"]): VNode {
  return h("section", { class: "migration-section" }, [
    h("h2", {}, [section.heading]),
    ...section.lines.map((line) => h("p", { class: "meta" }, [line])),
    h("a", { class: "migration-link", href: section.href }, [section.linkLabel]),
  ]);
}

// ---- 移行画面(Issue #222) ----

function barNode(bar: { readonly value: number; readonly max: number }, label: string): VNode {
  return h("progress", { class: "migration-bar", value: String(bar.value), max: String(bar.max), "aria-label": label }, []);
}

function notice(tone: "info" | "ok" | "error" | "wait", text: string): VNode {
  return tone === "error" ? h("p", { class: "notice error", role: "alert" }, [text]) : h("p", { class: tone === "info" ? "notice" : `notice ${tone}` }, [text]);
}

function progressSection(p: ProgressView): VNode {
  return h("section", { class: "migration-progress" }, [
    h("h2", {}, ["取り込みの進捗"]),
    notice(p.tone, p.headline),
    ...(p.bar === null ? [] : [barNode(p.bar, "取り込みの進捗")]),
    ...(p.lines.length === 0 ? [] : [h("ul", { class: "migration-lines" }, p.lines.map((line) => h("li", {}, [line])))]),
    ...(p.conflicts === null ? [] : [h("p", { class: "notice" }, [p.conflicts.text]), h("ul", { class: "migration-lines" }, p.conflicts.samples.map((sample) => h("li", {}, [sample])))]),
    ...(p.failure === null ? [] : [notice("error", `${p.failure.heading}理由: ${p.failure.reason}`), h("p", { class: "meta" }, [p.failure.hint])]),
  ]);
}

/** 結果の補完の 1 行(Issue #217)。 */
function backfillSection(b: BackfillView): VNode {
  return h("section", { class: "migration-backfill" }, [notice(b.tone, b.text), ...(b.note === null ? [] : [h("p", { class: "meta" }, [b.note])])]);
}

function checkSection(check: CheckView, cancelable: boolean, actions: ViewActions): VNode[] {
  // エラーは理由まで 1 つの role=alert にまとめる(読み上げが途切れない)。それ以外は 1 行目を通知、残りを補足にする。
  const [first, ...rest] = check.tone === "error" ? [check.lines.join(" ")] : check.lines;
  return [
    notice(check.tone, first ?? ""),
    ...rest.map((line) => h("p", { class: "meta" }, [line])),
    ...(check.bar === null ? [] : [barNode(check.bar, "検証の進捗")]),
    ...(cancelable ? [h("button", { class: "migration-cancel" }, ["検証をやめる"], { click: actions.onMigrationCancelCheck })] : []),
  ];
}

function migrationScreen(model: MigrationModel, actions: ViewActions): VNode {
  const controls = h("div", { class: "controls" }, [
    h("a", { class: "back", href: model.backHref }, ["設定へ戻る"]),
    h("button", { class: "refresh", disabled: model.reloadDisabled }, [model.loading ? "読み込み中…" : "再読込"], { click: actions.onRefresh }),
  ]);
  const body: VNode[] = [h("h1", { class: "title" }, ["exe から移行"]), ...model.intro.map((line) => h("p", { class: "meta" }, [line]))];
  if (model.loading) {
    body.push(h("p", { class: "empty" }, ["読み込み中…"]));
  }
  if (model.error !== null) {
    body.push(notice("error", model.error));
  }
  if (model.pollNotice !== null) {
    body.push(notice("info", model.pollNotice));
  }
  if (model.progress !== null) {
    body.push(progressSection(model.progress));
  }
  if (model.backfill !== null) {
    body.push(backfillSection(model.backfill));
  }
  if (model.canPick || model.file !== null || model.pickNote !== null) {
    body.push(h("h2", {}, ["ファイルを選ぶ"]));
  }
  if (model.canPick) {
    body.push(
      h("label", { class: "field-label" }, [
        h("span", { class: "field-name" }, ["exe で書き出したファイル(.ndjson.gz)"]),
        h("input", { class: "migration-file", type: "file", accept: ".gz,application/gzip,application/x-gzip" }, [], { file: actions.onMigrationFile }),
      ]),
    );
  }
  if (model.pickNote !== null) {
    body.push(notice("wait", model.pickNote));
  }
  if (model.file !== null) {
    body.push(h("p", { class: "meta" }, [`選んだファイル: ${model.file.name}(${model.file.sizeText})`]));
  }
  if (model.check !== null) {
    body.push(...checkSection(model.check, model.canCancelCheck, actions));
  }
  if (model.start.visible) {
    body.push(h("button", { class: "migration-start", disabled: !model.start.enabled }, [model.start.label], { click: actions.onMigrationStart }));
  }
  if (model.uploadNotice !== null) {
    body.push(notice(model.uploadNotice.tone, model.uploadNotice.text));
  }
  return h("div", { class: "screen" }, [controls, ...body]);
}

// ---- 検証画面(Issue #219) ----

function verifyNotice(n: VerifyNotice): VNode {
  return notice(n.tone, n.text);
}

function tilesNode(tiles: readonly { readonly label: string; readonly value: string; readonly strong: boolean }[]): VNode {
  return h(
    "div",
    { class: "verify-tiles" },
    tiles.map((t) => h("div", { class: t.strong ? "verify-tile strong" : "verify-tile" }, [h("span", { class: "verify-tile-label" }, [t.label]), h("strong", { class: "verify-tile-value" }, [t.value])])),
  );
}

function rowsNode(rows: readonly { readonly label: string; readonly value: string }[]): VNode {
  return h("ul", { class: "verify-rows" }, rows.map((r) => h("li", {}, [h("span", { class: "verify-row-label" }, [r.label]), h("span", { class: "verify-row-value" }, [r.value])])));
}

function typeRowsNode(rows: readonly { readonly label: string; readonly count: string; readonly rate: string }[]): VNode {
  return h("ul", { class: "verify-rows" }, rows.map((r) => h("li", {}, [h("span", { class: "verify-row-label" }, [r.label]), h("span", { class: "verify-row-value" }, [`${r.count} / ${r.rate}`])])));
}

/** 補正方向・キャリブレーションの帯・印の行(Issue #220)。ラベルと「名前 値」の項目を、狭い幅では折り返す(表は使わない)。帯グラフは `progress`(style を使わない)。 */
function statRowsNode(rows: readonly StatRow[]): VNode {
  return h(
    "ul",
    { class: "verify-stats" },
    rows.map((r) =>
      h("li", { class: "verify-stat" }, [
        h("span", { class: "verify-stat-label" }, [r.label]),
        h(
          "div",
          { class: "verify-stat-cells" },
          r.cells.map((c) => h("span", { class: "verify-stat-cell" }, [h("span", { class: "verify-stat-name" }, [c.name]), h("strong", { class: "verify-stat-value" }, [c.value])])),
        ),
        ...(r.bar === null ? [] : [h("progress", { class: "verify-stat-bar", value: String(r.bar.value), max: String(r.bar.max), "aria-label": r.bar.label }, [])]),
      ]),
    ),
  );
}

function statSectionNodes(section: StatSection): VNode[] {
  return [h("h2", {}, [section.heading]), h("p", { class: "meta" }, [section.description]), statRowsNode(section.rows)];
}

/** 版別比較の 1 版のカード(Issue #220)。キャリブレーションは開いたときだけ。開閉の値は `data-*` にも出す(`createMounter` は関数を比較しない=`result-toggle` と同じ流儀)。 */
function versionCardNode(card: VersionCard, actions: ViewActions): VNode {
  const toggle = h(
    "button",
    { class: "verify-version-toggle", "aria-expanded": card.expanded ? "true" : "false", "data-version-key": card.key, "data-open-after": card.expanded ? "false" : "true" },
    [card.toggleLabel],
    { click: () => actions.onVerifyVersionToggle(card.key, !card.expanded) },
  );
  const opened: VNode[] = [];
  if (card.expanded) {
    if (card.calibrationHeading !== null) opened.push(h("p", { class: "verify-version-calibration-heading" }, [card.calibrationHeading]));
    if (card.fullInstructions !== null) opened.push(h("p", { class: "meta verify-version-instructions-full" }, [card.fullInstructions]));
    opened.push(card.calibrationEmpty !== null ? h("p", { class: "empty" }, [card.calibrationEmpty]) : statRowsNode(card.calibrationRows));
  }
  return h("section", { class: "verify-version" }, [
    h("h3", { class: "verify-version-title" }, [card.title]),
    h("p", { class: "meta verify-version-instructions" }, [card.instructions]),
    h("p", { class: "meta" }, [card.included]),
    tilesNode(card.tiles),
    toggle,
    ...opened,
  ]);
}

function versionsNodes(section: VersionsSection, actions: ViewActions): VNode[] {
  const nodes: VNode[] = [h("h2", {}, [section.heading]), h("p", { class: "meta" }, [section.description])];
  if (section.unknownNote !== null) nodes.push(h("p", { class: "meta" }, [section.unknownNote]));
  if (section.empty !== null) nodes.push(h("p", { class: "empty" }, [section.empty]));
  nodes.push(...section.cards.map((card) => versionCardNode(card, actions)));
  return nodes;
}

function verifyScreen(model: VerifyModel, actions: ViewActions): VNode {
  const controls = h("div", { class: "controls" }, [
    h("a", { class: "back", href: model.backHref }, ["一覧へ戻る"]),
    h("button", { class: "refresh", disabled: model.refreshDisabled }, [model.loading ? "読み込み中…" : "更新"], { click: actions.onRefresh }),
  ]);
  const venues = h(
    "div",
    { class: "verify-venues", role: "group", "aria-label": "検証の地域フィルタ" },
    model.venueTabs.map((t) => h("button", { class: "verify-venue", "aria-pressed": t.current ? "true" : "false" }, [t.label], { click: () => actions.onVerifyVenue(t.venue) })),
  );
  const body: VNode[] = [h("h1", { class: "title" }, ["検証"]), venues];
  if (model.loading && model.bet === null) {
    body.push(h("p", { class: "empty" }, ["読み込み中…"]));
  }
  if (model.error !== null) {
    body.push(notice("error", model.error));
  }
  if (model.pollNotice !== null) {
    body.push(notice("info", model.pollNotice));
  }
  if (model.unavailable !== null) {
    body.push(verifyNotice(model.unavailable));
  }
  if (model.computedAt !== null) {
    body.push(h("p", { class: "meta" }, [`集計時点: ${model.computedAt}`]));
  }
  for (const n of model.notices) {
    body.push(verifyNotice(n));
  }
  if (model.bet !== null) {
    const b = model.bet;
    body.push(h("h2", {}, [b.heading]), h("p", { class: "meta" }, [b.description]));
    if (b.empty !== null) {
      body.push(h("p", { class: "empty" }, [b.empty]));
    } else {
      body.push(tilesNode(b.tiles));
      if (b.payoutLine !== null) body.push(h("p", { class: "meta" }, [b.payoutLine]));
    }
    body.push(h("h3", {}, [b.exclusionHeading]), rowsNode(b.exclusions));
    if (b.exclusionNote !== null) body.push(h("p", { class: "meta" }, [b.exclusionNote]));
  }
  if (model.proposed !== null) {
    const p = model.proposed;
    body.push(h("h2", {}, [p.heading]), h("p", { class: "meta" }, [p.description]));
    if (p.empty !== null) {
      body.push(h("p", { class: "empty" }, [p.empty]));
    } else {
      body.push(tilesNode(p.tiles), h("h3", {}, [p.typeHeading]), typeRowsNode(p.types));
      if (p.unjudged !== null) body.push(h("h3", {}, [p.unjudged.heading]), rowsNode(p.unjudged.rows));
      if (p.unknownNotice !== null) body.push(notice("wait", p.unknownNotice));
    }
    body.push(h("h3", {}, [p.populationHeading]), rowsNode(p.population));
  }
  if (model.versions !== null) {
    body.push(...versionsNodes(model.versions, actions));
  }
  if (model.direction !== null) {
    body.push(...statSectionNodes(model.direction));
  }
  if (model.calibration !== null) {
    const c = model.calibration;
    body.push(h("h2", {}, [c.heading]), h("p", { class: "meta" }, [c.description]));
    body.push(c.empty !== null ? h("p", { class: "empty" }, [c.empty]) : statRowsNode(c.rows));
  }
  if (model.marks !== null) {
    body.push(...statSectionNodes(model.marks));
  }
  return h("div", { class: "screen verify-screen" }, [controls, ...body]);
}

// ---- 日報画面(Issue #235) ----

function bulletList(items: readonly string[]): VNode {
  return h("ul", { class: "report-list" }, items.map((t) => h("li", {}, [t])));
}

function reportRaceNode(r: RaceRowView): VNode {
  return h("section", { class: "report-race", "data-race": r.raceId }, [
    h("h3", {}, [r.title]),
    h("p", { class: "report-result" }, [r.result]),
    ...(r.marks === null ? [] : [h("p", { class: "report-marks" }, [r.marks])]),
    h("p", { class: "report-bets" }, [r.bets]),
    ...(r.comment === null ? [] : [h("p", { class: "report-comment" }, [`一言: ${r.comment}`])]),
  ]);
}

function reportBodyNodes(b: ReportBodyView): VNode[] {
  const nodes: VNode[] = [h("h2", {}, [b.heading]), h("p", { class: "meta" }, [b.meta]), tilesNode(b.tiles)];
  if (b.textNote !== null) nodes.push(notice("info", b.textNote));
  if (b.summary !== null) nodes.push(h("h3", {}, ["総括"]), h("p", { class: "report-summary" }, [b.summary]));
  if (b.good.length > 0) nodes.push(h("h3", {}, ["良かった点"]), bulletList(b.good));
  if (b.improve.length > 0) nodes.push(h("h3", {}, ["改善点"]), bulletList(b.improve));
  if (b.raw !== null) nodes.push(h("p", { class: "report-raw" }, [b.raw]));
  if (b.typeRows.length > 0) nodes.push(h("h3", {}, [b.typeHeading]), rowsNode(b.typeRows));
  if (b.markRows.length > 0) nodes.push(h("h3", {}, [b.markHeading]), rowsNode(b.markRows));
  nodes.push(h("h2", {}, [b.racesHeading]), ...b.races.map(reportRaceNode));
  return nodes;
}

function reportScreen(model: ReportModel, actions: ViewActions): VNode {
  const controls = h("div", { class: "controls" }, [
    h("a", { class: "back", href: model.backHref }, ["一覧へ戻る"]),
    h("button", { class: "refresh", disabled: model.refreshDisabled }, [model.loading ? "読み込み中…" : "更新"], { click: actions.onRefresh }),
  ]);
  const chips = h(
    "nav",
    { class: "tabs", "aria-label": "日報の日付" },
    model.dateChips.map((c) => h("a", { class: "tab", href: c.href, "aria-current": c.current ? "page" : undefined }, [c.label])),
  );
  const body: VNode[] = [h("h1", { class: "title" }, [model.heading]), chips];
  if (model.loading && model.body === null) body.push(h("p", { class: "empty" }, ["読み込み中…"]));
  if (model.error !== null) body.push(notice("error", model.error));
  if (model.notice !== null) body.push(notice(model.notice.tone, model.notice.text));
  if (model.create !== null) {
    // 確定の注意は、ボタンの手前(押す前に読める位置)に出す。今日の日付のときは、強めの注意を足す。
    body.push(h("p", { class: "meta report-caution" }, [model.create.caution]));
    if (model.create.todayCaution !== null) body.push(notice("wait", model.create.todayCaution));
    body.push(h("button", { class: "report-run", disabled: model.create.disabled }, [model.create.label], { click: actions.onReportRun }));
  }
  if (model.body !== null) body.push(...reportBodyNodes(model.body));
  return h("div", { class: "screen report-screen" }, [controls, ...body]);
}

/** 管理者だけの画面を閲覧者が開いたときの案内(Issue #238)。固定文言と、一覧へ戻るリンクだけ。 */
function adminOnlyScreen(model: AdminOnlyModel): VNode {
  return h("div", { class: "screen" }, [
    h("div", { class: "controls" }, [h("a", { class: "back", href: model.backHref }, ["一覧へ戻る"])]),
    h("h1", { class: "title" }, [model.heading]),
    h("p", { class: "notice" }, [model.message]),
  ]);
}

export function renderScreen(model: ListModel | RaceModel | ResultModel | SettingsModel | MigrationModel | VerifyModel | ReportModel | AdminOnlyModel, actions: ViewActions): VNode {
  switch (model.kind) {
    case "list":
      return listScreen(model, actions);
    case "race":
      return raceScreen(model, actions);
    case "result":
      return resultScreen(model, actions);
    case "settings":
      return settingsScreen(model, actions);
    case "migration":
      return migrationScreen(model, actions);
    case "verify":
      return verifyScreen(model, actions);
    case "report":
      return reportScreen(model, actions);
    case "admin-only":
      return adminOnlyScreen(model);
  }
}
