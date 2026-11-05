import { google, calendar_v3 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

function getCalendarClient(): calendar_v3.Calendar {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: SCOPES,
  });

  return google.calendar({ version: "v3", auth });
}

const calendarId = process.env.GOOGLE_CALENDAR_ID!;

export interface CalendarEvent {
  summary: string;
  start: string; // ISO 8601（終日の場合は YYYY-MM-DD）
  end: string; // ISO 8601（終日の場合は排他的な終了日 YYYY-MM-DD）
  description?: string;
  notionPageId?: string;
}

/**
 * 予定の extendedProperties.private に保存する同期情報。
 * synced* は「最後に両者が一致していた時点のタイトル・日時」で、
 * 次回同期時にどちら側が変更されたかを判定するのに使う。
 */
export interface SyncSnapshot {
  notionPageId?: string;
  syncedSummary?: string;
  syncedStart?: string;
  syncedEnd?: string;
}

function toEventDateTime(
  value: string,
  isAllDay: boolean
): calendar_v3.Schema$EventDateTime {
  return isAllDay ? { date: value } : { dateTime: value, timeZone: "Asia/Tokyo" };
}

function buildRequestBody(event: CalendarEvent): calendar_v3.Schema$Event {
  const isAllDay = !event.start.includes("T");
  const end = event.end || event.start;

  return {
    summary: event.summary,
    description: event.description,
    start: toEventDateTime(event.start, isAllDay),
    end: toEventDateTime(end, isAllDay),
    ...(event.notionPageId
      ? {
          extendedProperties: {
            private: {
              notionPageId: event.notionPageId,
              syncedSummary: event.summary,
              syncedStart: event.start,
              syncedEnd: end,
            },
          },
        }
      : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: number }).code === 404
  );
}

/**
 * Googleカレンダーにイベントを作成
 * @returns 作成されたイベントのID
 */
export async function createEvent(event: CalendarEvent): Promise<string> {
  const calendar = getCalendarClient();

  const response = await calendar.events.insert({
    calendarId,
    requestBody: buildRequestBody(event),
  });

  return response.data.id!;
}

/**
 * Googleカレンダーのイベントを更新
 */
export async function updateEvent(
  eventId: string,
  event: CalendarEvent
): Promise<void> {
  const calendar = getCalendarClient();

  await calendar.events.update({
    calendarId,
    eventId,
    requestBody: buildRequestBody(event),
  });
}

/**
 * 同期スナップショットだけを更新（予定の内容は変えない）
 */
export async function setSyncSnapshot(
  eventId: string,
  snapshot: Required<SyncSnapshot>
): Promise<void> {
  const calendar = getCalendarClient();

  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      extendedProperties: { private: { ...snapshot } },
    },
  });
}

/**
 * Googleカレンダーのイベントを削除
 */
export async function deleteEvent(eventId: string): Promise<void> {
  const calendar = getCalendarClient();

  try {
    await calendar.events.delete({
      calendarId,
      eventId,
    });
  } catch (error: unknown) {
    // 既に削除されている場合は無視
    if (isNotFound(error)) {
      console.log(`Event ${eventId} already deleted, skipping.`);
    } else {
      throw error;
    }
  }
}

/**
 * Googleカレンダーのイベントを取得
 */
export async function getEvent(
  eventId: string
): Promise<calendar_v3.Schema$Event | null> {
  const calendar = getCalendarClient();

  try {
    const response = await calendar.events.get({
      calendarId,
      eventId,
    });
    return response.data;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * 指定時刻以降に更新されたイベントを取得（削除済みイベントは除外）
 */
export async function listUpdatedEvents(
  sinceTimestamp: string
): Promise<calendar_v3.Schema$Event[]> {
  const calendar = getCalendarClient();
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;

  do {
    const response = await calendar.events.list({
      calendarId,
      updatedMin: sinceTimestamp,
      maxResults: 250,
      pageToken,
    });

    for (const event of response.data.items ?? []) {
      // updatedMin 指定時は削除済み(cancelled)も必ず返ってくるので除外
      if (event.status !== "cancelled") events.push(event);
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return events;
}
