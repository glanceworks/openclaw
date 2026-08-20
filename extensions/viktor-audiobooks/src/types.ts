export type Route = {
  chatId: string;
  accountId?: string;
  threadId?: number;
};

export type BookJob = {
  stage: string;
  stage_label: string;
  status: string;
  status_label: string;
  in_progress: boolean;
  user_action: string | null;
  updated_at: string;
};

export type BookRequest = {
  id: string;
  title: string;
  author: string;
  status: string;
  status_label: string;
  created_at: string;
  updated_at: string;
  cancel_allowed: boolean;
  job: BookJob | null;
};

export type Candidate = {
  id: number;
  title?: string;
  size_bytes?: number | null;
  selected: boolean;
  metadata?: { author?: string };
};

export type CandidateSet = {
  request_id: string;
  kind: "release" | "nzb";
  candidates: Candidate[];
};

export type CreateIntent = {
  idempotencyKey: string;
  actor: string;
  title: string;
  author: string;
  route: Route;
  requestId?: string;
  cardDeliveryStartedAt?: number;
  cardDeliveryUncertainAt?: number;
  createdAt: number;
};

export type RequestBinding = {
  requestId: string;
  actor: string;
  route: Route;
  messageId: number;
  fingerprint: string;
  nextPollAt: number;
  failureCount: number;
  terminal: boolean;
  terminalNotified: boolean;
  terminalNotificationStartedAt?: number;
  createdAt: number;
};

export type CallbackAction = "select_release" | "authorize" | "select_nzb" | "cancel";

export type CallbackIntent = {
  token: string;
  actor: string;
  requestId: string;
  action: CallbackAction;
  candidateId?: number;
  route: Route;
  messageId?: number;
  requestFingerprint: string;
  idempotencyKey: string;
  createdAt: number;
};

export type TelegramButton = {
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
};

export type RenderedCard = {
  text: string;
  buttons: TelegramButton[][];
  callbackTokens: string[];
};

export type PluginConfig = {
  applicationBaseUrl: string;
  tailnetOnlyHttp: boolean;
  createReadToken: string;
  controlToken: string;
  actorDerivationSecret: string;
  ownerNotificationTarget?: string;
  ownerToolEnabled: boolean;
};
