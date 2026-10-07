/**
 * 画面の VNode(Issue #184。純関数)。表示用データ(`list.ts`)を、DOM に依存しない木にする。
 * 文字列の子は、アダプタ(`dom.ts`)がテキストノードにする(外から来た文字列が HTML として解釈されない)。
 */
import type { Badge, ListModel, PendingModel, RaceItem } from "./list";
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

function pendingScreen(model: PendingModel): VNode {
  return h("div", { class: "screen" }, [h("p", { class: "empty" }, [model.text]), h("a", { class: "back", href: model.backHref }, ["一覧へ戻る"])]);
}

export function renderScreen(model: ListModel | PendingModel, actions: ViewActions): VNode {
  return model.kind === "list" ? listScreen(model, actions) : pendingScreen(model);
}
