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
  if (kind === "release") {
    const author = candidate.metadata?.author;
    return `${candidate.title ?? "Release"}${typeof author === "string" ? ` — ${author}` : ""}`
      .slice(0, 55);
  }
  return `Exact match ${position}${candidate.size_bytes ? ` — ${Math.round(candidate.size_bytes / 1_048_576)} MB` : ""}`
    .slice(0, 55);
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
    for (const candidate of candidates.candidates.slice(0, 8)) {
      if (!candidate.selected) {
        await add(candidateLabel(candidate, "release", 0), "select_release", candidate.id);
      }
    }
    const selected = candidates.candidates.find((candidate) => candidate.selected);
    if (selected) {
      await add("Get this book", "authorize", selected.id, "success");
    }
  } else if (candidates?.kind === "nzb") {
    for (const [index, candidate] of candidates.candidates.slice(0, 8).entries()) {
      await add(candidateLabel(candidate, "nzb", index + 1), "select_nzb", candidate.id);
    }
  }
  if (request.cancel_allowed) {
    await add("Cancel this request", "cancel", undefined, "danger");
  }

  const lines = [
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
  if (
    request.job?.user_action &&
    request.job.user_action !== "select_release_in_web" &&
    request.job.user_action !== "select_nzb_in_web"
  ) {
    lines.push("Owner action required in Audiobook Automation.");
  }
  if (isTerminal(request.status)) lines.push("This request is finished.");
  return { text: lines.join("\n"), buttons: rows, callbackTokens: tokens };
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
