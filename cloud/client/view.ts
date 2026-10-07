/**
 * 画面の VNode(Issue #184。純関数)。表示用データ(`list.ts`・`race.ts`〈#185〉・`result.ts`〈#185〉)を、DOM に依存しない木にする。
 * 文字列の子は、アダプタ(`dom.ts`)がテキストノードにする(外から来た文字列が HTML として解釈されない)。
 * Issue #188: 発走前のカードの中に最新の分析の結果を出す。馬ごと・配分の部分は結果画面と共通の `resultSections`(見出しの階層だけ違う)。
 * #185 で足した画面は、#184 の要素・属性の許可リスト(`dom.ts`)の範囲だけで組む(新しい要素・属性は足していない。一覧は `ul`、強調は class と文字)。
 */
import type { TaskMode } from "./api";
import type { Badge, ListModel, RaceGroupItem, RaceItem } from "./list";
import type { CardResult, RaceModel, TaskCard } from "./race";
import type { HorseCard, ResultContent, ResultModel } from "./result";
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
          h("p", { class: "meta" }, [`分析時刻: ${content.analyzedAt}`]),
          h("p", { class: "meta" }, [`分析モデル: ${content.model}`]),
          ...(content.detailNote === null ? [] : [h("p", { class: "notice" }, [content.detailNote])]),
          ...resultSections(content, "h3"),
        ]
      : []),
  ]);
}

function taskCard(card: TaskCard, actions: ViewActions): VNode {
  return h("section", { class: "card" }, [
    h("h2", {}, [card.title]),
    h("span", { class: `badge ${card.badge.tone}` }, [card.badge.label]),
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

function horseCard(horse: HorseCard): VNode {
  return h("li", { class: horse.positive ? "horse positive" : "horse" }, [
    h("span", { class: "horse-head" }, [
      h("strong", {}, [`${horse.umaban}`]),
      ...(horse.name === null ? [] : [h("span", { class: "horse-name" }, [horse.name])]),
      ...(horse.mark === null ? [] : [h("span", { class: "mark" }, [horse.mark])]),
    ]),
    h("span", { class: "horse-line" }, [`3着内率 ${horse.prior}`]),
    h("span", { class: "horse-line" }, [`複勝オッズ下限 ${horse.odds}`]),
    h("span", { class: "horse-line" }, [`EV ${horse.ev}`, ...(horse.positive ? [h("strong", { class: "ev-plus" }, ["EVプラス"])] : [])]),
  ]);
}

/**
 * 結果の「馬ごとの評価」と「配分の提案」(結果画面と、レース画面の発走前のカード〈Issue #188〉で共通。重複して実装しない)。
 * `heading` は見出しの要素(結果画面は h2、カードの中はカードの見出し h2 の下なので h3)。
 */
function resultSections(content: ResultContent, heading: "h2" | "h3"): VNode[] {
  const allocation = content.allocation;
  return [
    h("section", { class: "horses" }, [h(heading, {}, ["馬ごとの評価"]), h("ul", { class: "horse-list" }, content.horses.map(horseCard))]),
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
    body.push(h("p", { class: "meta" }, [`分析時刻: ${content.analyzedAt}`]));
    body.push(h("p", { class: "meta" }, [`分析モデル: ${content.model}`]));
    if (content.detailNote !== null) {
      body.push(h("p", { class: "notice" }, [content.detailNote]));
    }
    body.push(...resultSections(content, "h2"));
  }  return h("div", { class: "screen" }, [controls, ...body]);
}

export function renderScreen(model: ListModel | RaceModel | ResultModel, actions: ViewActions): VNode {
  switch (model.kind) {
    case "list":
      return listScreen(model, actions);
    case "race":
      return raceScreen(model, actions);
    case "result":
      return resultScreen(model, actions);
  }
}
