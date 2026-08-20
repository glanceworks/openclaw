import { randomBytes, randomUUID } from "node:crypto";

import type { KeyedStore } from "./state.js";
import type {
  BookRequest,
  CallbackAction,
  CallbackIntent,
  CandidateSet,
  RenderedCard,
  Route,
  TelegramButton,
} from "./types.js";

// Telegram edits cannot split a card across messages, so leave headroom below its 4,000-character limit.
const TELEGRAM_EDITABLE_CARD_TEXT_BUDGET = 3_900;
const RELEASE_TITLE_TEXT_BUDGET = 220;
const RELEASE_AUTHOR_TEXT_BUDGET = 100;

export function requestFingerprint(request: BookRequest): string {
  return [
    request.id,
    request.status,
    request.updated_at,
    request.job?.stage ?? "",
    request.job?.status ?? "",
    request.job?.updated_at ?? "",
  ].join("|");
}

function candidateLabel(
  candidate: CandidateSet["candidates"][number],
  kind: CandidateSet["kind"],
  position: number,
): string {
  if (kind === "release") return `Choose #${position}`;
  return `Exact match ${position}${candidate.size_bytes ? ` — ${Math.round(candidate.size_bytes / 1_048_576)} MB` : ""}`
    .slice(0, 55);
}

function truncateCardText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  if (maximumLength <= 1) return "…".slice(0, maximumLength);

  let end = maximumLength - 1;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function conciseCardValue(value: string, maximumLength: number): string {
  return truncateCardText(value.trim().replace(/\s+/gu, " "), maximumLength);
}

function releaseDescription(
  candidate: CandidateSet["candidates"][number],
  position: number,
): string {
  const author = candidate.metadata?.author;
  const title = candidate.title?.trim()
    ? conciseCardValue(candidate.title, RELEASE_TITLE_TEXT_BUDGET)
    : "Edition";
  const authorSuffix =
    typeof author === "string" && author.trim()
      ? ` — ${conciseCardValue(author, RELEASE_AUTHOR_TEXT_BUDGET)}`
      : "";
  return `#${position} ${title}${authorSuffix}`;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

export function requestIsTerminal(request: BookRequest): boolean {
  return isTerminal(request.status);
}

export function safeRequestStatus(status: string): string {
  switch (status) {
    case "new": return "Queued";
    case "searching": return "Searching";
    case "waiting_user": return "Waiting for input";
    case "in_progress": return "In progress";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    default: return "Processing";
  }
}

function safeStage(stage: string): string {
  switch (stage) {
    case "discover": return "Searching";
    case "select_release": return "Choose an edition";
    case "preflight_library": return "Checking your library";
    case "select_nzb": return "Choose a download";
    case "submit_sab":
    case "monitor_sab": return "Downloading";
    case "validate_media": return "Checking media";
    case "import_abs":
    case "verify_abs":
    case "enrich_metadata": return "Adding to library";
    case "retention":
    case "cleanup": return "Finishing";
    case "done": return "Completed";
    default: return "Processing";
  }
}

function safeJobStatus(status: string): string {
  switch (status) {
    case "pending": return "Queued";
    case "running": return "In progress";
    case "waiting_user": return "Waiting for input";
    case "waiting_external": return "Waiting";
    case "retry_scheduled": return "Retrying";
    case "needs_login":
    case "needs_attention": return "Owner action required";
    case "succeeded": return "Step complete";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    default: return "Processing";
  }
}

export async function renderCard(params: {
  request: BookRequest;
  candidates?: CandidateSet;
  actor: string;
  route: Route;
  messageId?: number;
  callbacks: KeyedStore<CallbackIntent>;
}): Promise<RenderedCard> {
  const { request, candidates, actor, route, messageId, callbacks } = params;
  const fingerprint = requestFingerprint(request);
  const tokens: string[] = [];
  const rows: TelegramButton[][] = [];

  const add = async (
    label: string,
    action: CallbackAction,
    candidateId?: number,
    style?: TelegramButton["style"],
  ) => {
    const token = randomBytes(18).toString("base64url");
    const intent: CallbackIntent = {
      token,
      actor,
      requestId: request.id,
      action,
      ...(candidateId === undefined ? {} : { candidateId }),
      route,
      ...(messageId === undefined ? {} : { messageId }),
      requestFingerprint: fingerprint,
      idempotencyKey: `tg-control-${randomUUID()}`,
      createdAt: Date.now(),
    };
    await callbacks.register(token, intent);
    tokens.push(token);
    rows.push([{ text: label, callback_data: `vab:${token}`, ...(style ? { style } : {}) }]);
  };

  if (candidates?.kind === "release") {
    for (const [index, candidate] of candidates.candidates.slice(0, 8).entries()) {
      await add(candidateLabel(candidate, "release", index + 1), "acquire_release", candidate.id);
    }
  } else if (candidates?.kind === "nzb") {
    for (const [index, candidate] of candidates.candidates.slice(0, 8).entries()) {
      await add(candidateLabel(candidate, "nzb", index + 1), "select_nzb", candidate.id);
    }
  }
  if (request.cancel_allowed) {
    await add("Cancel this request", "cancel", undefined, "danger");
  }

  const selectedEdition = request.selected_edition;
  const lines = selectedEdition
    ? [
        `Audiobook: ${request.title}`,
        ...(request.author ? [`Author: ${request.author}`] : []),
        "",
        "Selected edition:",
        "",
        selectedEdition.title,
        selectedEdition.author,
        ...(selectedEdition.year ? [selectedEdition.year] : []),
        ...(selectedEdition.series ? [selectedEdition.series] : []),
        "",
        "Status:",
        request.job ? safeStage(request.job.stage) : safeRequestStatus(request.status),
      ]
    : [
        `Audiobook: ${request.title}`,
        ...(request.author ? [`Author: ${request.author}`] : []),
        `Status: ${safeRequestStatus(request.status)}`,
        ...(request.job
          ? [
              `Step: ${safeStage(request.job.stage)}`,
              `Progress: ${safeJobStatus(request.job.status)}`,
            ]
          : []),
      ];
  if (candidates?.kind === "release" && !selectedEdition) {
    lines.push(
      "",
      "Available editions:",
      ...candidates.candidates
        .slice(0, 8)
        .map((candidate, index) => releaseDescription(candidate, index + 1)),
    );
  }
  if (
    request.job?.user_action &&
    request.job.user_action !== "select_release_in_web" &&
    request.job.user_action !== "select_nzb_in_web"
  ) {
    lines.push("Owner action required in Audiobook Automation.");
  }
  if (isTerminal(request.status)) lines.push("This request is finished.");
  return {
    text: truncateCardText(lines.join("\n"), TELEGRAM_EDITABLE_CARD_TEXT_BUDGET),
    buttons: rows,
    callbackTokens: tokens,
  };
}

export async function bindCallbackMessage(
  store: KeyedStore<CallbackIntent>,
  tokens: string[],
  messageId: number,
): Promise<void> {
  for (const token of tokens) {
    const intent = await store.lookup(token);
    if (intent) await store.register(token, { ...intent, messageId });
  }
}
