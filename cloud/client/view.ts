/**
 * 画面の VNode(Issue #184。純関数)。表示用データ(`list.ts`・`race.ts`〈#185〉・`result.ts`〈#185〉)を、DOM に依存しない木にする。
 * 文字列の子は、アダプタ(`dom.ts`)がテキストノードにする(外から来た文字列が HTML として解釈されない)。
 * #185 で足した画面は、#184 の要素・属性の許可リスト(`dom.ts`)の範囲だけで組む(新しい要素・属性は足していない。一覧は `ul`、強調は class と文字)。
 */
import type { Badge, ListModel, RaceItem } from "./list";
import type { RaceModel, TaskCard } from "./race";
import type { HorseCard, ResultModel } from "./result";
import { h, type VNode } from "./vnode";

export interface ViewActions {
  /** 日付の入力欄の値(YYYY-MM-DD。空・不正なこともある)。 */
  readonly onDateChange: (value: string) => void;
  readonly onRefresh: () => void;
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
    body.push(h("section", { class: "venue" }, [h("h2", {}, [group.name]), h("ul", { class: "races" }, group.races.map(raceRow))]));
  }
  return h("div", { class: "screen" }, [controls, ...notices, ...body]);
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

function taskCard(card: TaskCard): VNode {
  return h("section", { class: "card" }, [
    h("h2", {}, [card.title]),
    h("span", { class: `badge ${card.badge.tone}` }, [card.badge.label]),
    ...(card.error === null ? [] : [h("p", { class: "card-error" }, [card.error])]),
    ...(card.prior === null ? [] : [h("ul", { class: "prior" }, card.prior.map(priorRow))]),
    ...(card.resultHref === null ? [] : [h("a", { class: "result-link", href: card.resultHref }, ["結果を見る"])]),
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
    body.push(...model.cards.map(taskCard));
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
  return h("div", { class: "screen" }, [controls, h("h1", { class: "title" }, [model.title]), ...body, h("section", { class: "past-section" }, [h("h2", {}, ["過去の分析"]), ...pastBody])]);
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
    body.push(h("section", { class: "horses" }, [h("h2", {}, ["馬ごとの評価"]), h("ul", { class: "horse-list" }, content.horses.map(horseCard))]));
    const allocation = content.allocation;
    body.push(
      h("section", { class: "allocation" }, [
        h("h2", {}, ["配分の提案(分析時点)"]),
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
    );
  }
  return h("div", { class: "screen" }, [controls, ...body]);
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
