import { NextRequest, NextResponse } from "next/server";
import { syncNotionToGCal } from "@/lib/sync";

/**
 * GET /api/sync
 *
 * Notion ⇄ Google Calendar の双方向同期を実行するAPIエンドポイント
 * Vercel Cron または外部cronサービスからトリガーされる
 */
export async function GET(request: NextRequest) {
  // CRON_SECRET による認証チェック
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 }
    );
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // デフォルトでは過去15分間の更新を同期
    // クエリパラメータ ?full=true で全件同期
    const { searchParams } = new URL(request.url);
    const fullSync = searchParams.get("full") === "true";

    let sinceTimestamp: string | undefined;
    if (!fullSync) {
      // 15分前のタイムスタンプ
      const since = new Date(Date.now() - 15 * 60 * 1000);
      sinceTimestamp = since.toISOString();
    }

    console.log(
      `同期開始: ${fullSync ? "全件同期" : `${sinceTimestamp} 以降の更新`}`
    );

    const result = await syncNotionToGCal(sinceTimestamp);

    console.log(
      `同期完了: 作成=${result.created}, 更新=${result.updated}, 削除=${result.deleted}, Notion更新=${result.notionUpdated}, エラー=${result.errors.length}`
    );

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("同期エラー:", message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
