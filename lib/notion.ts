import { Client } from "@notionhq/client";
import type {
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID!;

// Notionのプロパティ名
const WHEN_PROPERTY = "いつやる？";
const GCAL_ID_PROPERTY = "GCalEventID";

export interface NotionTask {
  id: string;
  title: string;
  titleProperty: string; // タイトルプロパティの名前
  whenStart: string | null; // ISO 8601
  whenEnd: string | null; // ISO 8601
  gcalEventId: string | null;
  lastEditedTime: string;
}

/**
 * Notionデータベースのすべてのタスクを取得
 * last_edited_time でフィルタ可能
 */
export async function getNotionTasks(
  sinceTimestamp?: string
): Promise<NotionTask[]> {
  const tasks: NotionTask[] = [];
  let hasMore = true;
  let startCursor: string | undefined;

  while (hasMore) {
    const response = await notion.dataSources.query({
      data_source_id: databaseId,
      start_cursor: startCursor,
      ...(sinceTimestamp
        ? {
            filter: {
              timestamp: "last_edited_time",
              last_edited_time: {
                on_or_after: sinceTimestamp,
              },
            },
          }
        : {}),
      sorts: [
        {
          timestamp: "last_edited_time",
          direction: "descending",
        },
      ],
    });

    for (const page of response.results) {
      if (!isFullPage(page)) continue;
      const task = parseNotionPage(page);
      if (task) tasks.push(task);
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return tasks;
}

/**
 * NotionページにGoogleカレンダーのイベントIDを保存
 */
export async function setGCalEventId(
  pageId: string,
  eventId: string
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [GCAL_ID_PROPERTY]: {
        rich_text: [
          {
            type: "text",
            text: { content: eventId },
          },
        ],
      },
    },
  });
}

/**
 * NotionページからGoogleカレンダーのイベントIDを削除
 */
export async function clearGCalEventId(pageId: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [GCAL_ID_PROPERTY]: {
        rich_text: [],
      },
    },
  });
}

/**
 * ページIDを指定してタスクを1件取得（ゴミ箱のページはnull）
 */
export async function getNotionTask(pageId: string): Promise<NotionTask | null> {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    if (!isFullPage(page) || page.in_trash || page.archived) return null;
    return parseNotionPage(page);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "object_not_found"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Notionタスクのタイトル・「いつやる？」を更新（指定した項目のみ）
 */
export async function updateNotionTask(
  task: NotionTask,
  changes: {
    title?: string;
    when?: { start: string; end: string | null };
  }
): Promise<void> {
  const properties: Parameters<typeof notion.pages.update>[0]["properties"] = {};

  if (changes.title !== undefined) {
    properties[task.titleProperty] = {
      title: [{ type: "text", text: { content: changes.title } }],
    };
  }
  if (changes.when) {
    properties[WHEN_PROPERTY] = { date: changes.when };
  }
  if (Object.keys(properties).length === 0) return;

  await notion.pages.update({ page_id: task.id, properties });
}

/**
 * GCalEventIDプロパティを持つ全タスクを取得（削除検知用）
 */
export async function getTasksWithGCalId(): Promise<NotionTask[]> {
  const tasks: NotionTask[] = [];
  let hasMore = true;
  let startCursor: string | undefined;

  while (hasMore) {
    const response = await notion.dataSources.query({
      data_source_id: databaseId,
      start_cursor: startCursor,
      filter: {
        property: GCAL_ID_PROPERTY,
        rich_text: {
          is_not_empty: true,
        },
      },
    });

    for (const page of response.results) {
      if (!isFullPage(page)) continue;
      const task = parseNotionPage(page);
      if (task) tasks.push(task);
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return tasks;
}

// --- Internal helpers ---

function isFullPage(page: unknown): page is PageObjectResponse {
  return (page as PageObjectResponse).object === "page" && "properties" in (page as PageObjectResponse);
}

function parseNotionPage(page: PageObjectResponse): NotionTask | null {
  const properties = page.properties;

  // タイトルを取得
  const titleEntry = Object.entries(properties).find(
    ([, p]) => p.type === "title"
  );
  const titleProperty = titleEntry?.[0] ?? "title";
  const titleProp = titleEntry?.[1];
  const title =
    titleProp?.type === "title"
      ? titleProp.title.map((t) => t.plain_text).join("")
      : "無題";

  // 「いつやる？」の日付を取得
  const whenProp = properties[WHEN_PROPERTY];
  let whenStart: string | null = null;
  let whenEnd: string | null = null;

  if (whenProp?.type === "date" && whenProp.date) {
    whenStart = whenProp.date.start;
    whenEnd = whenProp.date.end;
  }

  // GCalEventIDを取得
  const gcalProp = properties[GCAL_ID_PROPERTY];
  let gcalEventId: string | null = null;

  if (gcalProp?.type === "rich_text" && gcalProp.rich_text.length > 0) {
    gcalEventId = gcalProp.rich_text.map((t) => t.plain_text).join("");
  }

  return {
    id: page.id,
    title,
    titleProperty,
    whenStart,
    whenEnd,
    gcalEventId,
    lastEditedTime: page.last_edited_time,
  };
}
