/**
 * 設定画面(`#settings`。Issue #189)の制御。`app.ts` から切り出した(Issue #400 R-11)。`verify-screen.ts` などと同じ形(`create*Screen`)で、DOM・fetch は注入する(Node でテストできる)。
 * 開くと `GET /api/settings` だけを取る(一覧・板・レース・分析は取らない)。失敗は自動で再試行しない(「再読込」だけ。取得中・保存中は無視)。
 *  - 状態は closure に持つ: 取得の状態・下書き(`settings-form.ts`。数値は入力した文字のまま)・検証エラー・保存の状態。**画面を離れたら破棄**し(`leave`)、戻ると取り直す。
 *  - **入力(数値欄・追加指示は `input`〈打つたび〉と `change`、チェックボックス・選択は `change`)は下書きを書くだけで、再描画しない**(入力中の欄・フォーカスを壊さない。保存中の入力は無視。
 *    `input` でも書くのは、`change` が blur で発火し、フォーカスがあるまま「保存」を押して click が先に届くと、直前の入力を取りこぼすため)。保存・再読込・取得・失敗の直後は **`onChange(true)`**
 *    (木が前回と同じでも DOM を置き換える。change では描画しないので、DOM が下書きと食い違ったまま残るのを、強制の再描画で直す)。
 *  - **強制なしの描画(追跡のポーリングなど、設定画面の外の原因)は、画面に出ている内容の写し(`settingsShown`)から木を作る**(`model(false)`)。`input` で下書きが変わっても木は変わらず、`createMounter` が DOM を置き換えない
 *    (打っている欄・キーボードを壊さない)。
 *  - 保存の押下: 検証(項目ごと。保存の押下時に1回)→ NG なら POST せず項目ごとのエラー / OK なら全項目を POST。保存中は二重に送らない。失敗しても入力は残る。成功したらサーバが返した設定で下書きを戻す。
 *  - 世代(`settingsGen`): 離れる・取り直すたびに増やし、**古い世代の応答(離れる前に出した取得・保存)は今の画面に反映しない**。
 *  - **Issue #201(プロンプトのプレビュー)**: 画面の末尾のボタンで開閉する(既定は閉じている。メモリだけ・画面を離れたら破棄)。文面は **画面に出ている写し(`settingsShown`)の下書き**から作る。
 *    **入力のたびには更新しない**(#189 の設計どおり)。開閉と「入力中の内容を反映」は `onChange(true)` で、写しを現在の下書きへ更新してから描く
 *    (強制なしだと古い写しで入力欄が作り直され、打った文字が消える)。保存中・下書きなしは無視。
 *  - **Issue #396(文面はサーバが組み立てる)**: 文面は `POST /api/settings/prompt-preview`(`api-prompt-preview.ts`)で取る(クライアントの束に `build-prompt` を入れない)。取りに行くのは、
 *    **開いたとき・「入力中の内容を反映」・強制描画で写しの入力(追加指示とクリップ幅)が前回の取得と変わったとき**だけ(打つたび・ポーリングでは取らない)。取り直している間は前回の文面を出し続ける
 *    (最初の取得だけ固定の文言)。失敗は固定の文言(「入力中の内容を反映」で再試行)。連打は最後の応答だけを採る(連番)。画面を離れたら応答を捨てる(世代)。
 *    **応答が届いたとき、下書きが写しと違う(反映を押した後に打ち始めた)なら、強制描画に切り替えて写しを現在の下書きへ更新する**
 *    (通常の描画だと古い写しで入力欄が作り直され、打った文字が消える。このときは新しい取得を起こさない=次に押すまで文面に出ない契約は保つ)。
 *  - **閲覧者(Issue #238)**: 設定は管理者だけの画面。閲覧者の route は `app.ts` の `currentScreen()` が `admin-only` にするので、`isActive()` が false になり、ここは何も取らない・何も受けない。
 */
import type { FetchLike } from "./api";
import { fetchPromptPreview, previewRequestKey } from "./api-prompt-preview";
import { fetchSettings, postSettings, settingsFailureMessage } from "./api-settings";
import { buildSettingsModel, draftFromSettings, resetWeightsInDraft, setDraftValue, validateDraft, WEIGHT_FIELD_ORDER, type FieldErrors, type FieldKey, type PreviewFetchState, type SettingsDraft, type SettingsLoadState, type SettingsModel, type SettingsSaveState } from "./settings-form";

export interface SettingsScreenDeps {
  readonly fetch: FetchLike;
  /** 今の画面が設定か(`app.ts` の `currentScreen() === "settings"`。閲覧者は false)。false のとき、入力・保存・開閉などの操作は何もしない。 */
  readonly isActive: () => boolean;
  /** 画面の再描画の要求。`force` が true のときは、木が同じでも DOM を置き換える。 */
  readonly onChange: (force?: boolean) => void;
}

export interface SettingsScreen {
  /** 画面に入った。まだ取っていなければ取る(重ねて呼んでも取得は増えない)。 */
  enter(): void;
  /** 画面を離れた。下書き・エラー・保存の状態を捨て、世代を進める(遅れて届く応答を捨てる)。戻ると取り直す。 */
  leave(): void;
  /** 「再読込」。取得中・保存中は無視。未保存の入力は捨てて、サーバの値を取り直す。 */
  onRefresh(): void;
  /** 入力欄の変更。下書きを書くだけで、再描画しない。 */
  onInput(key: string, value: string): void;
  onSave(): void;
  /** プロンプトのプレビューの開閉(Issue #201)。 */
  onPreviewToggle(open: boolean): void;
  /** 「入力中の内容を反映」。 */
  onPreviewRefresh(): void;
  /** 「重みを既定値に戻す」(Issue #218)。 */
  onWeightsReset(): void;
  /** 描画用データ。`force` が true、または画面に入った直後は今の状態を写し、それ以外は画面に出ている内容の写しから作る。 */
  model(force: boolean): SettingsModel;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

export function createSettingsScreen(deps: SettingsScreenDeps): SettingsScreen {
  /** 取得の状態。null は「まだ取っていない(この画面にいない)」。 */
  let settingsLoad: SettingsLoadState | null = null;
  let settingsDraft: SettingsDraft | null = null;
  let settingsErrors: FieldErrors = {};
  let settingsSave: SettingsSaveState = { kind: "idle" };
  /** 世代。離れる・取り直すたびに増やし、古い世代の応答を捨てる。 */
  let settingsGen = 0;
  /**
   * 画面に出ている内容(最後に**強制描画**したとき、または画面に入ったときの、取得の状態・下書き・エラー・保存の状態の写し)。
   * **強制なしの描画(追跡のポーリング・他の取得の完了など、設定画面の外の原因)は、この写しから木を作る**=打っている途中の下書きは、
   * 次の強制描画(保存・再読込・取得完了・検証エラー・失敗)まで木に出さない。木が同じなら `createMounter` は DOM を置き換えない(打っている欄がフォーカスを失わない・スマホのキーボードが閉じない)。
   * 下書き(`settingsDraft`)自体は最新のまま(保存はそれを読む)。null は「まだ写していない(画面に入った直後)」。
   */
  let settingsShown: { load: SettingsLoadState; draft: SettingsDraft | null; errors: FieldErrors; save: SettingsSaveState; previewOpen: boolean } | null = null;
  /** プロンプトのプレビューを開いているか(Issue #201)。メモリだけ(既定は閉じている。画面を離れたら破棄。「再読込」では変えない)。 */
  let settingsPreviewOpen = false;
  /** プレビューの文面の取得(Issue #396)。`key` は取得したときの入力の鍵(`previewRequestKey`)、`state` は取得中・成功・失敗。 */
  let settingsPreview: { key: string; state: PreviewFetchState } | null = null;
  /** プレビューの取得の連番(連打・開閉をまたいで、最後の応答だけを採る)。 */
  let settingsPreviewSeq = 0;
  /** 次の強制描画で、入力が前回の取得と同じでも取り直す(開いたとき・「入力中の内容を反映」)。 */
  let settingsPreviewForce = false;
  /** 次の強制描画で、プレビューの取得を起こさない(応答の到着時の入力の保護。`syncSettingsPreview`)。 */
  let settingsPreviewHold = false;
  const settingsInflight = new Set<Promise<unknown>>();

  /** 設定を取り直す(下書き・エラー・保存の状態を捨てる)。**呼び出し側が描画する**。 */
  function startSettingsLoad(): void {
    settingsGen += 1;
    const gen = settingsGen;
    settingsLoad = { kind: "loading" };
    settingsDraft = null;
    settingsErrors = {};
    settingsSave = { kind: "idle" };
    // 飛んでいるプレビューの応答は世代(上)で捨てられるので、文面の状態も捨てる(Issue #396 R1)。残すと取得中のまま・同じ鍵で取り直されず、「組み立てています…」で止まる。
    // 取り直した設定の描画(強制)で、開いていれば取得し直す(`leaveSettings` と同じく連番も進める)。
    settingsPreview = null;
    settingsPreviewSeq += 1;
    const promise = fetchSettings(deps.fetch).then((result) => {
      settingsInflight.delete(promise);
      if (gen !== settingsGen) return; // 離れた・取り直した(古い応答)
      if (result.ok) {
        settingsLoad = { kind: "ready", source: result.source };
        settingsDraft = draftFromSettings(result.settings);
      } else {
        settingsLoad = { kind: "error", message: settingsFailureMessage(result.error, "load") };
      }
      deps.onChange(true);
    });
    settingsInflight.add(promise);
  }

  /**
   * プレビューの文面を取り直すかを決め、要るなら取りに行く(Issue #396)。**写し(`settingsShown`)を更新した直後**に呼ぶ(文面は写しの下書きから作る=今までと同じ)。
   * 取るのは、開いていて、写しに下書きがあり、(開く・「入力中の内容を反映」で取り直しを求められたか、写しの入力が前回の取得と違う)とき。
   * 応答の到着時: 世代(離れた・取り直した)か連番(より新しい取得がある)が違えば捨てる。下書きが写しと違う(反映を押した後に打ち始めた)ときは、強制描画で写しを現在の下書きへ更新し
   * (通常の描画は古い写しで入力欄を作り直し、打った文字が消える)、その描画では取得を起こさない(`settingsPreviewHold`。文面が入力に追いつくのは次に押したときだけ、の契約を保つ)。
   */
  function syncSettingsPreview(): void {
    const forced = settingsPreviewForce;
    const hold = settingsPreviewHold;
    settingsPreviewForce = false;
    settingsPreviewHold = false;
    const shown = settingsShown;
    if (hold || !settingsPreviewOpen || shown === null || shown.draft === null || shown.load.kind !== "ready") return;
    const input = { additionalInstruction: String(shown.draft.additionalInstruction), clipVariant: String(shown.draft.clipVariant) };
    const key = previewRequestKey(input);
    if (!forced && settingsPreview !== null && settingsPreview.key === key) return;
    const state = settingsPreview?.state;
    const previous = state?.kind === "ready" ? state.preview : state?.kind === "loading" ? state.previous : null;
    settingsPreviewSeq += 1;
    const seq = settingsPreviewSeq;
    const gen = settingsGen;
    settingsPreview = { key, state: { kind: "loading", previous } };
    const promise = fetchPromptPreview(deps.fetch, input).then((result) => {
      settingsInflight.delete(promise);
      if (gen !== settingsGen || seq !== settingsPreviewSeq) return; // 離れた・取り直した・より新しい取得がある(古い応答)
      settingsPreview = { key, state: result.ok ? { kind: "ready", preview: result.preview } : { kind: "error" } };
      if (settingsDraft !== null && settingsShown !== null && JSON.stringify(settingsDraft) !== JSON.stringify(settingsShown.draft)) {
        settingsPreviewHold = true;
        deps.onChange(true);
      } else {
        deps.onChange();
      }
    });
    settingsInflight.add(promise);
  }

  /** 設定画面を離れる: 下書き・エラー・保存の状態を捨て、世代を進める(遅れて届く応答を捨てる)。戻ると取り直す。 */
  function leaveSettings(): void {
    settingsGen += 1;
    settingsShown = null;
    settingsPreviewOpen = false;
    settingsPreview = null;
    settingsPreviewSeq += 1;
    settingsPreviewForce = false;
    settingsPreviewHold = false;
    settingsLoad = null;
    settingsDraft = null;
    settingsErrors = {};
    settingsSave = { kind: "idle" };
  }

  /** 入力欄の変更。**下書きを書くだけで、再描画しない**(入力中の欄・フォーカスを壊さない)。保存中・取得前は無視。 */
  function onSettingsInput(key: string, value: string): void {
    if (!deps.isActive() || settingsDraft === null || settingsSave.kind === "saving") return;
    settingsDraft = setDraftValue(settingsDraft, key as FieldKey, value);
    // 「保存しました」の通知は、未保存の入力が生まれた時点で状態から外す(描画はしない。次の描画から出さない)。
    if (settingsSave.kind === "saved") settingsSave = { kind: "idle" };
  }

  /**
   * プロンプトのプレビューの開閉(Issue #201)。開くと、文面の取得(Issue #396)が始まる。**`onChange(true)`**: 強制なしの描画は古い写し(`settingsShown`)から木を作るので、そのままだと
   * 入力欄が古い下書きで作り直され、打った文字が消える。強制描画は、写しを現在の下書きへ更新してから描く(保存・検証エラーと同じ)。
   * 下書きが無い(取得前・失敗)・保存中は無視する(入力を無視するのと同じ)。
   */
  function onSettingsPreviewToggle(open: boolean): void {
    if (!deps.isActive() || settingsDraft === null || settingsSave.kind === "saving") return;
    settingsPreviewOpen = open;
    // 開閉のたびに文面は捨てる(開くたびに今の下書きで取り直す)。取得中の応答は連番で捨てる。
    settingsPreview = null;
    settingsPreviewSeq += 1;
    settingsPreviewForce = open;
    deps.onChange(true);
  }

  /** 「入力中の内容を反映」(Issue #201): 開いているときだけ。強制描画で写しを現在の下書きへ更新し、プレビューの文面を取り直して入力に追いつかせる(Issue #396 以降は、サーバへの取得を伴う)。 */
  function onSettingsPreviewRefresh(): void {
    if (!deps.isActive() || settingsDraft === null || settingsSave.kind === "saving" || !settingsPreviewOpen) return;
    settingsPreviewForce = true; // 入力が前回と同じでも取り直す
    deps.onChange(true);
  }

  /**
   * 「重みを既定値に戻す」(Issue #218): 下書きの重み15項目だけを既定値に戻す(保存はしない。ネットワークには出ない)。重みの欄のエラーも消す(戻した値は有効)。
   * `onChange(true)`: 強制なしの描画は古い写し(`settingsShown`)から木を作るので、そのままだと欄が古い値のまま残る(プレビューの開閉と同じ)。
   * 下書きが無い(取得前・失敗)・保存中は無視する。
   */
  function onSettingsWeightsReset(): void {
    if (!deps.isActive() || settingsDraft === null || settingsSave.kind === "saving") return;
    settingsDraft = resetWeightsInDraft(settingsDraft);
    const remaining: Partial<Record<FieldKey, string>> = { ...settingsErrors };
    for (const key of WEIGHT_FIELD_ORDER) delete remaining[key];
    settingsErrors = remaining;
    if (settingsSave.kind === "saved") settingsSave = { kind: "idle" }; // 未保存の変更が生まれたので、「保存しました」を外す
    deps.onChange(true);
  }

  function onSettingsSave(): void {
    if (!deps.isActive() || settingsLoad?.kind !== "ready" || settingsDraft === null || settingsSave.kind === "saving") return;
    const checked = validateDraft(settingsDraft);
    if (!checked.ok) {
      settingsErrors = checked.errors;
      settingsSave = { kind: "idle" };
      deps.onChange(true);
      return;
    }
    settingsErrors = {};
    settingsSave = { kind: "saving" }; // 同期の印(await の前)。二重押しを防ぐ
    const gen = settingsGen;
    deps.onChange(true);
    const promise = postSettings(deps.fetch, checked.settings).then((result) => {
      settingsInflight.delete(promise);
      if (gen !== settingsGen) return; // 離れた・取り直した(古い応答)
      if (result.ok) {
        settingsDraft = draftFromSettings(result.settings);
        settingsLoad = { kind: "ready", source: "d1" };
        settingsSave = { kind: "saved" };
      } else {
        settingsSave = { kind: "error", message: settingsFailureMessage(result.error, "save") };
      }
      deps.onChange(true);
    });
    settingsInflight.add(promise);
  }

  /** 描画用データ。強制描画のとき、または画面に入った直後(まだ写していない)は、今の状態を写す。それ以外(強制なし)は、画面に出ている内容の写しから作る。 */
  function model(force: boolean): SettingsModel {
    if (force || settingsShown === null) {
      settingsShown = { load: settingsLoad ?? { kind: "loading" }, draft: settingsDraft, errors: settingsErrors, save: settingsSave, previewOpen: settingsPreviewOpen };
      syncSettingsPreview(); // 写しを更新したときだけ、プレビューの文面を取り直すかを決める(Issue #396)
    }
    return buildSettingsModel({ ...settingsShown, previewFetch: settingsPreview?.state ?? null });
  }

  /** 画面に入った: まだ取っていなければ取る。 */
  function enter(): void {
    if (settingsLoad === null) startSettingsLoad();
  }

  /** 「再読込」: 取得中・保存中は何もしない(同じものを同時に 2 本取らない・保存中の入力を捨てない)。未保存の入力は捨てて、サーバの値を取り直す。 */
  function onRefresh(): void {
    if (settingsLoad?.kind === "loading" || settingsSave.kind === "saving") return;
    startSettingsLoad();
    deps.onChange(true);
  }

  return {
    enter,
    leave: leaveSettings,
    onRefresh,
    onInput: onSettingsInput,
    onSave: onSettingsSave,
    onPreviewToggle: onSettingsPreviewToggle,
    onPreviewRefresh: onSettingsPreviewRefresh,
    onWeightsReset: onSettingsWeightsReset,
    model,
    pending: () => [...settingsInflight],
  };
}
