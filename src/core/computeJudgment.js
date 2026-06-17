// ============================================================
// sirube-ams-checker / 突合エンジン
// system_code: sys_ops_ams_checker
//
// AMS側ステータス × 媒体アダプタの fetchStatus 結果 → 最終judgment
// どの媒体アダプタの結果でも処理できる（媒体非依存）。
//
// 入力:
//   amsStatus   : "公開" | "商談中"（AMS巡回で取得した値）
//   fetchResult : アダプタの fetchStatus が返すオブジェクト
//                 { judgment, rawStatus, mediaStatus, note }
//   mediaName   : 媒体名（ログ・note文字列に使用。FreinsAdapter.mediaName 等）
//
// 出力: { dbJudgment, note }
//   dbJudgment : "match" | "mismatch" | "vanished" | "error"
//   note       : status_checks.note に記録する文字列
// ============================================================

export function computeJudgment(amsStatus, fetchResult, mediaName = "媒体") {
  const { judgment: fetchJudgment, rawStatus, mediaStatus, note: fetchNote } = fetchResult;

  // エラー系（取得失敗・セッション切れ等）
  if (fetchJudgment === "error") {
    return { dbJudgment: "error", note: fetchNote };
  }

  // 消失疑い（404）→ 再確認エンジンに委ねるまでの一時 vanished
  if (fetchJudgment === "vanished_suspected") {
    return { dbJudgment: "vanished", note: fetchNote };
  }

  // 詳細ページ取得成功: amsStatus × mediaStatus で突合
  if (amsStatus === "公開") {
    if (mediaStatus === "open") {
      return { dbJudgment: "match", note: `取引状況: 「${rawStatus}」` };
    }
    // 公開中以外はすべて mismatch（negotiating / unknown どちらも要確認）
    return {
      dbJudgment: "mismatch",
      note: `要注意・人間確認 / AMS公開 → ${mediaName}: 「${rawStatus}」`,
    };
  }

  if (amsStatus === "商談中") {
    if (mediaStatus === "negotiating") {
      return { dbJudgment: "match", note: `取引状況: 「${rawStatus}」` };
    }
    if (mediaStatus === "open") {
      // AMS商談中なのに媒体が公開中 = 逆転（珍しいが記録）
      return {
        dbJudgment: "mismatch",
        note: `要注意・AMS商談中だが${mediaName}公開中: 「${rawStatus}」`,
      };
    }
    return {
      dbJudgment: "mismatch",
      note: `要注意・人間確認 / AMS商談中 → ${mediaName}: 「${rawStatus}」`,
    };
  }

  // 予期しない amsStatus 値
  return {
    dbJudgment: "error",
    note: `ams_status不明: ${amsStatus} / ${mediaName}: 「${rawStatus}」`,
  };
}
