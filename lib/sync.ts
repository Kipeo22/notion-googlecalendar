import type { calendar_v3 } from "googleapis";
import {
  getNotionTasks,
  getNotionTask,
  setGCalEventId,
  clearGCalEventId,
  updateNotionTask,
  type NotionTask,
} from "./notion";
import {
  createEvent,
  updateEvent,
  deleteEvent,
  getEvent,
  listUpdatedEvents,
  setSyncSnapshot,
  type CalendarEvent,
} from "./google-calendar";

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  notionUpdated: number;
  errors: string[];
  details: string[];
}

interface TimeRange {
  start: string;
  end: string;
}

/**
 * Notion ⇄ Google Calendar の双方向同期を実行
 *
 * 同期ロジック:
 * 1. Notionから全タスク（または最近更新されたタスク）を取得
 * 2. 差分同期の場合、最近更新されたGCalイベントから紐づくNotionタスクも対象に加える
 * 3. 各タスクについて:
 *    - 「いつやる？」がある & GCalEventIDなし → 新規イベント作成
 *    - 「いつやる？」がある & GCalEventIDあり → タイトル・日時が食い違っていれば、
 *       変更された側の内容でもう一方を更新（GCal側の変更はNotionへ反映）
 *    - 「いつやる？」がない & GCalEventIDあり → イベント削除
 */
export async function syncNotionToGCal(
  sinceTimestamp?: string
): Promise<SyncResult> {
  const result: SyncResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    notionUpdated: 0,
    errors: [],
    details: [],
  };

  try {
    // Notionからタスクを取得
    const tasks = await getNotionTasks(sinceTimestamp);
    result.details.push(`Notionから ${tasks.length} 件のタスクを取得`);

    const taskMap = new Map<string, NotionTask>();
    for (const task of tasks) taskMap.set(normalizePageId(task.id), task);

    // 差分同期では、GCal側で最近変更された予定も拾う
    // （全件同期ではNotionの全タスクについて予定を取得するので不要）
    const prefetchedEvents = new Map<string, calendar_v3.Schema$Event>();
    if (sinceTimestamp) {
      const events = await listUpdatedEvents(sinceTimestamp);
      let linked = 0;

      for (const event of events) {
        const pageId = getLinkedPageId(event);
        if (!pageId || !event.id) continue;
        linked++;
        prefetchedEvents.set(event.id, event);

        if (taskMap.has(pageId)) continue;
        try {
          const task = await getNotionTask(pageId);
          // GCalEventIDが一致するものだけを対象にする（古い予定の誤反映を防ぐ）
          if (task && task.gcalEventId === event.id) {
            taskMap.set(pageId, task);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`予定「${event.summary}」のNotionタスク取得エラー: ${message}`);
        }
      }
      result.details.push(`GCalから更新された予定 ${linked} 件を取得`);
    }

    for (const task of taskMap.values()) {
      try {
        const prefetched = task.gcalEventId
          ? prefetchedEvents.get(task.gcalEventId)
          : undefined;
        await processTask(task, result, prefetched);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`タスク「${task.title}」の処理エラー: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`同期全体のエラー: ${message}`);
  }

  return result;
}

async function processTask(
  task: NotionTask,
  result: SyncResult,
  prefetchedEvent?: calendar_v3.Schema$Event
): Promise<void> {
  const hasWhenDate = task.whenStart !== null;
  const hasGCalId = task.gcalEventId !== null && task.gcalEventId !== "";

  if (hasWhenDate && !hasGCalId) {
    // 新規作成: 「いつやる？」があるが、まだGCalに登録されていない
    const event = taskToCalendarEvent(task);
    const eventId = await createEvent(event);
    await setGCalEventId(task.id, eventId);
    result.created++;
    result.details.push(`作成: 「${task.title}」→ GCal イベント ${eventId}`);
  } else if (hasWhenDate && hasGCalId) {
    const existingEvent =
      prefetchedEvent ?? (await getEvent(task.gcalEventId!));

    if (!existingEvent || existingEvent.status === "cancelled") {
      // GCalイベントが削除されている → 再作成
      const event = taskToCalendarEvent(task);
      const newEventId = await createEvent(event);
      await setGCalEventId(task.id, newEventId);
      result.created++;
      result.details.push(`再作成: 「${task.title}」→ GCal イベント ${newEventId}`);
      return;
    }

    await reconcile(task, existingEvent, result);
  } else if (!hasWhenDate && hasGCalId) {
    // 削除: 「いつやる？」が空でGCalEventIDがある
    await deleteEvent(task.gcalEventId!);
    await clearGCalEventId(task.id);
    result.deleted++;
    result.details.push(`削除: 「${task.title}」`);
  }
  // 「いつやる？」もGCalEventIDもなければ何もしない
}

/**
 * Notionタスクと既存のGCal予定を突き合わせ、食い違いを解消する
 */
async function reconcile(
  task: NotionTask,
  existingEvent: calendar_v3.Schema$Event,
  result: SyncResult
): Promise<void> {
  const eventId = task.gcalEventId!;
  const notionEvent = taskToCalendarEvent(task);
  const gcalTimes = getEventTimes(existingEvent);
  const gcalSummary = existingEvent.summary ?? "";
  const snap = existingEvent.extendedProperties?.private;

  const timesDiffer = !sameTimes(notionEvent, gcalTimes);
  const titleDiffer = gcalSummary !== task.title;

  if (!timesDiffer && !titleDiffer) {
    if (!snapshotMatches(existingEvent, notionEvent)) {
      // 内容は一致しているがスナップショットが古い/無い → 記録だけ更新
      await setSyncSnapshot(eventId, toSnapshot(notionEvent));
      result.details.push(`スキップ（変更なし、同期情報を記録）: 「${task.title}」`);
    } else {
      result.details.push(`スキップ（変更なし）: 「${task.title}」`);
    }
    return;
  }

  // タイトル・日時それぞれについて、どちらを正とするか決める
  let timesWinner: Winner | null = null;
  if (timesDiffer) {
    if (!snap?.syncedStart && isLegacyAllDayEncoding(notionEvent, gcalTimes)) {
      // 旧バージョンは複数日の終日予定の終了日を1日短く登録していた → Notionを正として修正
      timesWinner = "notion";
    } else {
      const snapTimes =
        snap?.syncedStart && snap?.syncedEnd
          ? { start: snap.syncedStart, end: snap.syncedEnd }
          : null;
      timesWinner = decideWinner(
        snapTimes ? !sameTimes(notionEvent, snapTimes) : null,
        snapTimes ? !sameTimes(gcalTimes, snapTimes) : null,
        task,
        existingEvent
      );
    }
  }

  let titleWinner: Winner | null = null;
  if (titleDiffer) {
    const snapSummary = snap?.syncedSummary;
    titleWinner =
      gcalSummary.trim() === ""
        ? "notion" // GCal側でタイトルが空にされた場合はNotionのタイトルを戻す
        : decideWinner(
            snapSummary !== undefined ? task.title !== snapSummary : null,
            snapSummary !== undefined ? gcalSummary !== snapSummary : null,
            task,
            existingEvent
          );
  }

  // GCal側の変更をNotionへ反映
  const notionChanges: Parameters<typeof updateNotionTask>[1] = {};
  if (titleWinner === "gcal") notionChanges.title = gcalSummary;
  if (timesWinner === "gcal") notionChanges.when = eventToNotionDate(existingEvent);

  const syncedTask: NotionTask = {
    ...task,
    title: notionChanges.title ?? task.title,
    whenStart: notionChanges.when?.start ?? task.whenStart,
    whenEnd: notionChanges.when ? notionChanges.when.end : task.whenEnd,
  };
  const syncedEvent = taskToCalendarEvent(syncedTask);

  if (notionChanges.title !== undefined || notionChanges.when) {
    await updateNotionTask(task, notionChanges);
    result.notionUpdated++;
    const parts: string[] = [];
    if (notionChanges.title !== undefined) {
      parts.push(`タイトルを「${notionChanges.title}」に`);
    }
    if (notionChanges.when) {
      const { start, end } = notionChanges.when;
      parts.push(`「いつやる？」を ${start}${end ? ` 〜 ${end}` : ""} に`);
    }
    result.details.push(`Notion更新: 「${task.title}」の${parts.join("、")}変更`);
  }

  // Notion側の変更をGCalへ反映（同時にスナップショットも更新される）
  if (titleWinner === "notion" || timesWinner === "notion") {
    await updateEvent(eventId, syncedEvent);
    result.updated++;
    result.details.push(`更新: 「${syncedTask.title}」`);
  } else {
    await setSyncSnapshot(eventId, toSnapshot(syncedEvent));
  }
}

type Winner = "notion" | "gcal";

/**
 * 食い違っている項目について、どちらの内容を正とするかを決める。
 * 1. スナップショット（最後に一致していた値）と比べて、片方だけ変わっていればそちら
 * 2. 両方変わっている／スナップショットが無い場合は、最終更新が新しい方
 *
 * notionChanged / gcalChanged が null のときはスナップショットが無いことを表す。
 */
function decideWinner(
  notionChanged: boolean | null,
  gcalChanged: boolean | null,
  task: NotionTask,
  existingEvent: calendar_v3.Schema$Event
): Winner {
  if (notionChanged !== null && gcalChanged !== null) {
    if (gcalChanged && !notionChanged) return "gcal";
    if (notionChanged && !gcalChanged) return "notion";
  }

  const gcalUpdated = Date.parse(existingEvent.updated ?? "");
  const notionUpdated = Date.parse(task.lastEditedTime);
  if (!Number.isNaN(gcalUpdated) && gcalUpdated > notionUpdated) return "gcal";
  return "notion";
}

function toSnapshot(event: CalendarEvent) {
  return {
    notionPageId: event.notionPageId!,
    syncedSummary: event.summary,
    syncedStart: event.start,
    syncedEnd: event.end,
  };
}

function isLegacyAllDayEncoding(
  notionEvent: CalendarEvent,
  gcalTimes: TimeRange
): boolean {
  return (
    !notionEvent.start.includes("T") &&
    gcalTimes.start === notionEvent.start &&
    gcalTimes.end === addDays(notionEvent.end, -1)
  );
}

function taskToCalendarEvent(task: NotionTask): CalendarEvent {
  const start = task.whenStart!;
  let end = task.whenEnd || task.whenStart!;

  // 終日イベント（時刻なし）の場合、GCalのendは「最終日の翌日」（排他的）
  if (!start.includes("T")) {
    end = addDays(end, 1);
  }

  const pageId = normalizePageId(task.id);
  return {
    summary: task.title,
    start,
    end,
    description: `Notion タスク: https://notion.so/${pageId}`,
    notionPageId: pageId,
  };
}

/**
 * GCal予定の日時を Notion の「いつやる？」形式に変換
 */
function eventToNotionDate(event: calendar_v3.Schema$Event): {
  start: string;
  end: string | null;
} {
  if (event.start?.date) {
    // 終日: GCalのendは排他的なので1日戻す。1日だけの予定ならendなし
    const start = event.start.date;
    const lastDay = event.end?.date ? addDays(event.end.date, -1) : start;
    return { start, end: lastDay > start ? lastDay : null };
  }

  const start = event.start!.dateTime!;
  const end = event.end?.dateTime ?? null;
  // 開始=終了（Notionで終了時刻なし）のときはendなし
  if (!end || normalizeDateTime(end) === normalizeDateTime(start)) {
    return { start, end: null };
  }
  return { start, end };
}

function getEventTimes(event: calendar_v3.Schema$Event): TimeRange {
  return {
    start: event.start?.dateTime || event.start?.date || "",
    end: event.end?.dateTime || event.end?.date || "",
  };
}

function sameTimes(a: TimeRange, b: TimeRange): boolean {
  return (
    normalizeDateTime(a.start) === normalizeDateTime(b.start) &&
    normalizeDateTime(a.end) === normalizeDateTime(b.end)
  );
}

function snapshotMatches(
  event: calendar_v3.Schema$Event,
  notionEvent: CalendarEvent
): boolean {
  const snap = event.extendedProperties?.private;
  if (!snap?.syncedStart || !snap?.syncedEnd || !snap?.notionPageId) return false;
  if (snap.syncedSummary !== notionEvent.summary) return false;
  return sameTimes(notionEvent, { start: snap.syncedStart, end: snap.syncedEnd });
}

/**
 * GCal予定に紐づくNotionページID（ハイフンなし）を取得
 * 新しい予定は extendedProperties、古い予定は説明欄のURLから判定する
 */
function getLinkedPageId(event: calendar_v3.Schema$Event): string | null {
  const fromProps = event.extendedProperties?.private?.notionPageId;
  if (fromProps) return normalizePageId(fromProps);

  const match = event.description?.match(/notion\.so\/([0-9a-f]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

function normalizePageId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 日時文字列を正規化して比較可能にする
 */
function normalizeDateTime(dt: string): string {
  if (!dt) return "";
  // 日付のみの場合はそのまま
  if (!dt.includes("T")) return dt;
  // ISO 8601形式の場合、UNIXタイムスタンプで比較
  const time = new Date(dt).getTime();
  return Number.isNaN(time) ? dt : time.toString();
}
