// ============================================================
// sirube-ams-checker / 404再確認エンジン
// system_code: sys_ops_ams_checker
//
// vanished_suspected（404）の物件を指定間隔を挟んで最大3回再確認し、
// 404確定 or 復活を判定して status_checks に append-only で記録する。
// どの MediaAdapter サブクラスでも使える（媒体非依存）。
//
// recheck-vanished.js の再確認ループをクラスに切り出した版。
// ロジック・判定・note文字列は移植元と同じ。
// ============================================================

import { computeJudgment } from "./computeJudgment.js";
import { insertStatusCheck } from "./StatusCheckStore.js";

export class RecheckEngine {
  // options:
  //   maxRounds          : 再確認回数の上限（デフォルト 3 ← §12 仕様）
  //   waitMinMs          : 1件ごとの最小待機時間（デフォルト 4000ms）
  //   waitRangeMs        : 1件ごとの乱数幅（デフォルト 2000ms → 4〜6秒）
  //   maxConsecutiveErrors: 連続エラー閾値（デフォルト 3）
  constructor({ pool, adapter, log, options = {} }) {
    this._pool = pool;
    this._adapter = adapter;
    this._log = log;
    this._maxRounds = options.maxRounds ?? 3;
    this._waitMinMs = options.waitMinMs ?? 4000;
    this._waitRangeMs = options.waitRangeMs ?? 2000;
    this._maxConsecutiveErrors = options.maxConsecutiveErrors ?? 3;
  }

  // queue: Array<{ objectId, mediaId, amsStatus }>
  //   objectId : AMS 物件番号（object_id）
  //   mediaId  : 媒体固有 ID（freins_id 等）
  //   amsStatus: AMS 側ステータス（"公開" / "商談中"）
  //
  // intervalMs: ラウンド間の待機時間（ミリ秒）
  // runId     : この再確認バッチの識別 ID
  async run(page, queue, intervalMs, runId) {
    const pending = new Map(
      queue.map(item => [item.objectId, { ...item, rechecksDone: 0 }])
    );

    for (let round = 1; round <= this._maxRounds; round++) {
      if (pending.size === 0) {
        this._log("INFO", "all_resolved_early", { round });
        break;
      }

      // ラウンド前に間隔待機（本番 1800000ms=30分 / テスト 120000ms=2分 等）
      this._log("INFO", "interval_wait_start", { round, intervalMs, pendingCount: pending.size });
      await this._sleep(intervalMs);
      this._log("INFO", "interval_wait_done", { round });

      const roundItems = [...pending.values()];
      this._log("INFO", "round_start", { round, count: roundItems.length });
      let consecutiveErrors = 0;

      for (let i = 0; i < roundItems.length; i++) {
        const prop = roundItems[i];
        this._log("INFO", "recheck_item", {
          round, i: i + 1, total: roundItems.length,
          objectId: prop.objectId, mediaId: prop.mediaId,
        });

        let fetchResult = await this._adapter.fetchStatus(page, prop.mediaId);

        // セッション切れ → 再ログイン後リトライ（1回まで）
        if (fetchResult.judgment === "error" && fetchResult.note?.includes("セッション切れ")) {
          this._log("WARN", "session_relogin", { mediaId: prop.mediaId });
          await this._adapter.login(page);
          fetchResult = await this._adapter.fetchStatus(page, prop.mediaId);
        }

        prop.rechecksDone++;
        const isFinalRound = round === this._maxRounds;

        // ページ復活 = error でも vanished_suspected でもない（detail が読めた）
        const pageRecovered =
          fetchResult.judgment !== "error" &&
          fetchResult.judgment !== "vanished_suspected";

        let dbJudgment, mediaStatus, note;

        if (pageRecovered) {
          // 復活 → その時点のステータスで突合確定
          const { dbJudgment: j, note: n } = computeJudgment(
            prop.amsStatus, fetchResult, this._adapter.mediaName
          );
          dbJudgment = j;
          mediaStatus = fetchResult.mediaStatus;
          note = `再確認${round}回目/${this._maxRounds}: ページ復活 → ${n}`;
          pending.delete(prop.objectId);
          this._log("INFO", "page_recovered", { round, objectId: prop.objectId, judgment: dbJudgment });

        } else if (fetchResult.judgment === "error") {
          // エラー（タイムアウト・ネットワーク等）
          dbJudgment = "error";
          mediaStatus = null;
          note = `再確認${round}回目/${this._maxRounds}: エラー → ${fetchResult.note}`;
          consecutiveErrors++;
          this._log("WARN", "recheck_error", {
            round, objectId: prop.objectId, note: fetchResult.note,
          });

        } else {
          // 404継続（vanished_suspected）
          mediaStatus = "vanished";
          const totalAttempts = 1 + prop.rechecksDone; // 1巡目 + 今回まで
          if (isFinalRound) {
            dbJudgment = "vanished";
            note = `再確認${round}回目/${this._maxRounds}: 404継続 → vanished確定（計${totalAttempts}回404）`;
            pending.delete(prop.objectId);
            this._log("INFO", "vanished_confirmed", { objectId: prop.objectId, totalAttempts });
          } else {
            dbJudgment = "vanished";
            note = `再確認${round}回目/${this._maxRounds}: 404継続（計${totalAttempts}回404）`;
            this._log("INFO", "still_vanished", { round, objectId: prop.objectId, totalAttempts });
          }
        }

        // status_checks に append-only で記録（1件ごとに即コミット）
        const writeClient = await this._pool.connect();
        try {
          await writeClient.query("BEGIN");
          await insertStatusCheck(writeClient, {
            objectId: prop.objectId,
            amsStatus: prop.amsStatus,
            media: this._adapter.mediaName,
            mediaStatus,
            judgment: dbJudgment,
            note,
            runId,
          });
          await writeClient.query("COMMIT");
        } catch (err) {
          await writeClient.query("ROLLBACK");
          throw err;
        } finally {
          writeClient.release();
        }

        // 連続エラーチェック（404 はエラーカウントにしない）
        if (fetchResult.judgment !== "error") consecutiveErrors = 0;
        if (consecutiveErrors >= this._maxConsecutiveErrors) {
          throw new Error(
            `連続エラーが ${this._maxConsecutiveErrors} 件。異常とみなして停止します。`
          );
        }

        // 1件ごとの待機（同一ラウンド内の最後の件は不要）
        if (i < roundItems.length - 1) {
          const waitMs = this._waitMinMs + Math.random() * this._waitRangeMs;
          this._log("INFO", "rate_limit_wait", { ms: Math.round(waitMs) });
          await page.waitForTimeout(waitMs);
        }
      }

      this._log("INFO", "round_done", { round, remaining: pending.size });
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
