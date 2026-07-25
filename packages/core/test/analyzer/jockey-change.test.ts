/**
 * 乗り替わり(騎手の継続/変更)要約(タスク#8・未使用パラメータ活用③)の純関数テスト。
 *
 * 今走騎手(ShutubaHorse.jockeyId/jockeyName)と前走騎手(HorseRaceResult.jockeyId/jockeyName、
 * results[0]のみ)を比較し「継続」か「乗り替わり」かを中立な事実として要約する。
 * jockeyId優先(両走とも非nullならid一致で判定)・id欠損時はjockeyName(トリム後・非空)で
 * 代替判定する設計を、境界値を含めテーブル駆動で網羅する。
 */

import { describe, expect, it } from "vitest";
import {
  summarizeJockeyChange,
  type JockeyChangePrevRunInput,
  type JockeyChangeTodayInput,
} from "../../src/analyzer/jockey-change.js";

describe("summarizeJockeyChange(騎手の継続/乗り替わり要約・純関数)", () => {
  it("(1) 前走なし(prevRun=null)のとき、nullを返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
    expect(summarizeJockeyChange(today, null)).toBeNull();
  });

  it("(2) 今走・前走ともjockeyId非nullで一致するとき、区分「継続」・根拠「id」を返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: "j001", jockeyName: "武豊" };
    const result = summarizeJockeyChange(today, prev);
    expect(result).toEqual({
      区分: "継続",
      今走騎手名: "武豊",
      前走騎手名: "武豊",
      判定根拠: "id",
      note: "騎手=武豊(前走から継続)",
    });
  });

  it("(3) 今走・前走ともjockeyId非nullで不一致のとき、区分「乗り替わり」・根拠「id」・前走名併記のnoteを返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: "j002", jockeyName: "川田将雅" };
    const result = summarizeJockeyChange(today, prev);
    expect(result).toEqual({
      区分: "乗り替わり",
      今走騎手名: "武豊",
      前走騎手名: "川田将雅",
      判定根拠: "id",
      note: "騎手=武豊(前走川田将雅から乗り替わり)",
    });
  });

  it("(4) id欠損(両走ともnull)でjockeyNameが一致するとき、区分「継続」・根拠「name」を返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: null, jockeyName: "武豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: null, jockeyName: "武豊" };
    const result = summarizeJockeyChange(today, prev);
    expect(result).toEqual({
      区分: "継続",
      今走騎手名: "武豊",
      前走騎手名: "武豊",
      判定根拠: "name",
      note: "騎手=武豊(前走から継続)",
    });
  });

  it("(5) id欠損(両走ともnull)でjockeyNameが不一致のとき、区分「乗り替わり」・根拠「name」を返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: null, jockeyName: "武豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: null, jockeyName: "川田将雅" };
    const result = summarizeJockeyChange(today, prev);
    expect(result).toEqual({
      区分: "乗り替わり",
      今走騎手名: "武豊",
      前走騎手名: "川田将雅",
      判定根拠: "name",
      note: "騎手=武豊(前走川田将雅から乗り替わり)",
    });
  });

  it("(6) 前走jockeyId=nullかつjockeyNameもnullのとき、nullを返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: null, jockeyName: null };
    expect(summarizeJockeyChange(today, prev)).toBeNull();
  });

  it("(6-b) 前走jockeyId=nullかつjockeyNameが空文字のとき、nullを返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: null, jockeyName: "" };
    expect(summarizeJockeyChange(today, prev)).toBeNull();
  });

  it("(6-c) 前走jockeyId=nullかつjockeyNameが空白のみのとき、nullを返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: null, jockeyName: "   " };
    expect(summarizeJockeyChange(today, prev)).toBeNull();
  });

  it("(7) 今走jockeyNameが空文字のとき、判定不能としてnullを返すこと", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "" };
    const prev: JockeyChangePrevRunInput = { jockeyId: "j001", jockeyName: "武豊" };
    expect(summarizeJockeyChange(today, prev)).toBeNull();
  });

  it("(7-b) 今走jockeyNameが空白のみのとき、判定不能としてnullを返すこと(今走名が無効なら id 一致でもフォールバックせず判定不能)", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "   " };
    const prev: JockeyChangePrevRunInput = { jockeyId: "j001", jockeyName: "武豊" };
    expect(summarizeJockeyChange(today, prev)).toBeNull();
  });

  it("(8) jockeyIdが一致するが表記ゆれで名前が相違するとき、id優先で「継続」と判定すること", () => {
    // 全角/半角スペース混入等の表記ゆれを想定(同一騎手・同一jockeyId)。
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武 豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: "j001", jockeyName: "武豊" };
    const result = summarizeJockeyChange(today, prev);
    expect(result?.区分).toBe("継続");
    expect(result?.判定根拠).toBe("id");
    expect(result?.note).toBe("騎手=武 豊(前走から継続)");
  });

  it("(9) 決定論: 同じ引数で2回呼んでも同じ結果になること", () => {
    const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
    const prev: JockeyChangePrevRunInput = { jockeyId: "j002", jockeyName: "川田将雅" };
    expect(summarizeJockeyChange(today, prev)).toEqual(
      summarizeJockeyChange(today, prev),
    );
  });

  describe("境界: id/nameの前後空白トリム", () => {
    it("今走jockeyNameの前後に空白があっても、トリムした値で一致判定・note表記すること", () => {
      const today: JockeyChangeTodayInput = { jockeyId: null, jockeyName: "  武豊  " };
      const prev: JockeyChangePrevRunInput = { jockeyId: null, jockeyName: "武豊" };
      const result = summarizeJockeyChange(today, prev);
      expect(result).toEqual({
        区分: "継続",
        今走騎手名: "武豊",
        前走騎手名: "武豊",
        判定根拠: "name",
        note: "騎手=武豊(前走から継続)",
      });
    });
  });

  describe("境界: 片側のみid欠損", () => {
    it("今走jockeyIdのみnull・前走jockeyId非nullのとき、name代替で判定すること", () => {
      const today: JockeyChangeTodayInput = { jockeyId: null, jockeyName: "武豊" };
      const prev: JockeyChangePrevRunInput = { jockeyId: "j001", jockeyName: "川田将雅" };
      const result = summarizeJockeyChange(today, prev);
      expect(result?.判定根拠).toBe("name");
      expect(result?.区分).toBe("乗り替わり");
    });

    it("今走jockeyId非null・前走jockeyIdのみnullのとき、name代替で判定すること", () => {
      const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
      const prev: JockeyChangePrevRunInput = { jockeyId: null, jockeyName: "武豊" };
      const result = summarizeJockeyChange(today, prev);
      expect(result?.判定根拠).toBe("name");
      expect(result?.区分).toBe("継続");
    });
  });

  describe("境界: 乗り替わり時に前走jockeyNameが取得できない場合のnoteフォールバック", () => {
    it("id不一致で乗り替わりだが前走jockeyNameがnullのとき、noteに「不明」を使い例外を投げないこと", () => {
      const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
      const prev: JockeyChangePrevRunInput = { jockeyId: "j002", jockeyName: null };
      const result = summarizeJockeyChange(today, prev);
      expect(result?.区分).toBe("乗り替わり");
      expect(result?.前走騎手名).toBeNull();
      expect(result?.note).toBe("騎手=武豊(前走不明から乗り替わり)");
    });
  });

  describe("禁止語彙: 評価語を出力に含めないこと", () => {
    it("noteに評価語(名手/主戦/強化/妙味/期待等)を含めないこと", () => {
      const today: JockeyChangeTodayInput = { jockeyId: "j001", jockeyName: "武豊" };
      const prev: JockeyChangePrevRunInput = { jockeyId: "j002", jockeyName: "川田将雅" };
      const result = summarizeJockeyChange(today, prev);
      const forbidden = ["名手", "主戦", "強化", "妙味", "期待", "べき", "推奨"];
      for (const word of forbidden) {
        expect(result?.note).not.toContain(word);
      }
    });
  });
});
