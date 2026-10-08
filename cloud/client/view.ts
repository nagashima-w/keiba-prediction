/**
 * 画面の VNode(Issue #184。純関数)。表示用データ(`list.ts`・`race.ts`〈#185〉・`result.ts`〈#185〉)を、DOM に依存しない木にする。
 * 文字列の子は、アダプタ(`dom.ts`)がテキストノードにする(外から来た文字列が HTML として解釈されない)。
 * Issue #188: 発走前のカードの中に最新の分析の結果を出す。馬ごと・配分の部分は結果画面と共通の `resultSections`(見出しの階層だけ違う)。
 * #185 で足した画面は、#184 の要素・属性の許可リスト(`dom.ts`)の範囲だけで組む(新しい要素・属性は足していない。一覧は `ul`、強調は class と文字)。
 */
import type { TaskMode } from "./api";
import type { Badge, ListModel, RaceGroupItem, RaceItem } from "./list";
import type { CardResult, RaceModel, TaskCard } from "./race";
import { LABEL_ADJUSTED_PROB, LABEL_CONCERNS, LABEL_HIGHLIGHTS, LABEL_PRIOR, type HorseCard, type MarkedHorse, type ResultContent, type ResultModel } from "./result";
import type { FieldModel, PreviewModel, SettingsModel } from "./settings-form";
import { h, type VNode } from "./vnode";

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
}

function badge(prefix: string, b: Badge): VNode {
  return h("span", { class: `badge ${b.tone}` }, [`${prefix}: ${b.label}`]);
}

function raceRow(item: RaceItem): VNode {
  const head = h("span", { class: "race-head" }, [h("strong", {}, [item.label]), h("span", { class: "race-name" }, [item.name]), ...(item.grade === null ? [] : [h("span", { class: "grade" }, [item.grade])])]);
  const detail = h("span", { class: "race-detail" }, [item.detail]);
  const badges = item.badges === null ? [] : [h("span", { class: "badges" }, [badge("朝", item.badges.morning), badge("発走前", item.badges.preRace)])];
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
function venueSection(group: RaceGroupItem, actions: ViewActions): VNode {
  const toggle = h("button", { class: "venue-toggle", "aria-expanded": group.open ? "true" : "false", "data-key": group.key }, [groupHeadingText(group)], { click: () => actions.onToggleGroup(group.key, !group.open) });
  return h("section", { class: "venue" }, [h("h2", {}, [toggle]), ...(group.open ? [h("ul", { class: "races" }, group.races.map(raceRow))] : [])]);
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
    h("a", { class: "settings-link", href: model.settingsHref }, ["設定"]),
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
function runButton(button: TaskCard["button"], actions: ViewActions): VNode {
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
    runButton(card.button, actions),
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
    h("strong", {}, [`${m.umaban}`]),
    ...(m.name === null ? [] : [h("span", { class: "marked-name" }, [m.name])]),
  ]);
}

/**
 * 結果の「印の付いた馬」(Issue #211。「馬ごとの評価」より前)・「馬ごとの評価」・「配分の提案」(結果画面と、レース画面の発走前のカード〈Issue #188〉で共通。重複して実装しない)。
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
    h("section", { class: "horses" }, [
      h(heading, {}, ["馬ごとの評価"]),
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
  return h("div", { class: "screen" }, [controls, h("h1", { class: "title" }, ["設定"]), ...body]);
}

export function renderScreen(model: ListModel | RaceModel | ResultModel | SettingsModel, actions: ViewActions): VNode {
  switch (model.kind) {
    case "list":
      return listScreen(model, actions);
    case "race":
      return raceScreen(model, actions);
    case "result":
      return resultScreen(model, actions);
    case "settings":
      return settingsScreen(model, actions);
  }
}
