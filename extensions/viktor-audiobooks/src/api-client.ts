import type { BookRequest, CandidateSet } from "./types.js";

export class ApplicationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Audiobook Automation request failed (${code}).`);
  }
}

type FetchResponse<T> = { request: T };

export class ApplicationApi {
  private readonly baseUrl: URL;

  constructor(
    applicationBaseUrl: string,
    private readonly createReadToken: string,
    private readonly controlToken: string,
    tailnetOnlyHttp: boolean,
  ) {
    this.baseUrl = new URL(applicationBaseUrl);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new Error("Audiobook Automation must be reached over HTTP or HTTPS.");
    }
    if (this.baseUrl.protocol === "http:" && !tailnetOnlyHttp) {
      throw new Error("Plain HTTP is permitted only for an explicitly acknowledged tailnet route.");
    }
    if (this.createReadToken === this.controlToken) {
      throw new Error("Create/read and control credentials must be different.");
    }
  }

  async create(
    actor: string,
    title: string,
    author: string,
    idempotencyKey: string,
  ): Promise<BookRequest> {
    const body = await this.request<FetchResponse<BookRequest>>(
      "requests/",
      this.createReadToken,
      actor,
      { method: "POST", idempotencyKey, body: { title, author } },
    );
    return body.request;
  }

  async status(actor: string, requestId: string): Promise<BookRequest> {
    const body = await this.request<FetchResponse<BookRequest>>(
      `requests/${encodeURIComponent(requestId)}/`,
      this.createReadToken,
      actor,
      { method: "GET" },
    );
    return body.request;
  }

  async candidates(actor: string, requestId: string): Promise<CandidateSet> {
    return await this.request<CandidateSet>(
      `requests/${encodeURIComponent(requestId)}/candidates/`,
      this.createReadToken,
      actor,
      { method: "GET" },
    );
  }

  async control(
    actor: string,
    requestId: string,
    action: "release-selection" | "reveal-authorization" | "nzb-selection" | "cancel",
    idempotencyKey: string,
    candidateId?: number,
  ): Promise<BookRequest> {
    const body = candidateId === undefined ? {} : { candidate_id: candidateId };
    const response = await this.request<FetchResponse<BookRequest>>(
      `requests/${encodeURIComponent(requestId)}/${action}/`,
      this.controlToken,
      actor,
      { method: "POST", idempotencyKey, body },
    );
    return response.request;
  }

  private async request<T>(
    relativePath: string,
    token: string,
    actor: string,
    options: {
      method: "GET" | "POST";
      idempotencyKey?: string;
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    const url = new URL(relativePath, new URL("api/v1/", this.baseUrl));
    if (url.origin !== this.baseUrl.origin) {
      throw new Error("Application API path escaped the configured origin.");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Viktor-Actor": actor,
      Accept: "application/json",
    };
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.body) headers["Content-Type"] = "application/json";
    const requestInit: RequestInit = {
      method: options.method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    };
    const response = await fetch(url, requestInit);
    if (!response.ok) {
      let code = `http_${response.status}`;
      try {
        const payload = (await response.json()) as { error?: { code?: unknown } };
        if (typeof payload.error?.code === "string") code = payload.error.code;
      } catch {
        // Do not surface or log an untrusted response body.
      }
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      throw new ApplicationApiError(
        response.status,
        code,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    return (await response.json()) as T;
  }
}
