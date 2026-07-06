/**
 * Thin HTTP client for the Kilkaya API (https://api.kilkaya.com).
 *
 * Authentication is a single API access token sent as a Bearer token.
 * The /api/query endpoint is asynchronous: while a query is queued or
 * running the API answers 202; the exact same query must be re-sent
 * every 2-3 seconds until a final response arrives (per API docs most
 * queries finish within 60 seconds).
 */

export interface KilkayaClientOptions {
  baseUrl?: string;
  /** How long to keep polling a 202 "query delayed" response. */
  queryTimeoutMs?: number;
  /** Delay between polls of a delayed query. */
  queryPollIntervalMs?: number;
}

export interface QueryFilter {
  column: string;
  operator: "like" | "notlike" | "greater" | "less";
  value: string | number;
}

export interface QueryRequest {
  datefrom: string;
  dateto: string;
  schemaname: string;
  columns: string[];
  filters?: QueryFilter[];
  sortby?: string[];
  sortorder?: ("asc" | "desc")[];
  limit?: number;
  skip?: number;
}

export class KilkayaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "KilkayaApiError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class KilkayaClient {
  private readonly baseUrl: string;
  private readonly queryTimeoutMs: number;
  private readonly queryPollIntervalMs: number;

  constructor(private readonly token: string, options: KilkayaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.kilkaya.com").replace(/\/+$/, "");
    this.queryTimeoutMs = options.queryTimeoutMs ?? 90_000;
    this.queryPollIntervalMs = options.queryPollIntervalMs ?? 2_500;
  }

  private async request(
    method: string,
    path: string,
    params?: Record<string, string | undefined>,
    body?: unknown
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.api+json, application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async parseOrThrow(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!response.ok) {
      throw new KilkayaApiError(
        `Kilkaya API responded with HTTP ${response.status}`,
        response.status,
        text.slice(0, 4000)
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async json(
    method: string,
    path: string,
    params?: Record<string, string | undefined>,
    body?: unknown
  ): Promise<unknown> {
    return this.parseOrThrow(await this.request(method, path, params, body));
  }

  /**
   * POST /api/query — the main analytics query API. Re-sends the exact
   * query while the API answers 202 (queued/running). If the configured
   * timeout is exceeded, the last 202 payload is returned so the caller
   * can see the queue status instead of getting a hard failure.
   */
  async query(query: QueryRequest): Promise<{ pending: boolean; result: unknown }> {
    const deadline = Date.now() + this.queryTimeoutMs;
    for (;;) {
      const response = await this.request("POST", "/api/query", undefined, query);
      if (response.status !== 202) {
        return { pending: false, result: await this.parseOrThrow(response) };
      }
      const status = await response.text();
      if (Date.now() + this.queryPollIntervalMs > deadline) {
        let parsed: unknown = status;
        try {
          parsed = JSON.parse(status);
        } catch {
          /* keep raw text */
        }
        return { pending: true, result: parsed };
      }
      await sleep(this.queryPollIntervalMs);
    }
  }

  /** GET /api/schemas — schema definitions with valid fields per schema. */
  async listSchemas(schemaname?: string, version?: string): Promise<unknown> {
    return this.json("GET", "/api/schemas", { schemaname, version });
  }

  /** GET /api/metadata — metadata for a single article url (without protocol). */
  async getMetadata(articleUrl: string): Promise<unknown> {
    return this.json("GET", "/api/metadata", { url: articleUrl });
  }

  /** POST /api/metadata — metadata for many urls at once. */
  async getMetadataBulk(urls: string[]): Promise<unknown> {
    return this.json("POST", "/api/metadata", undefined, { urls });
  }

  /** POST /api/metadata/set — store or update metadata for a given url. */
  async setMetadata(
    metadata: Record<string, unknown>,
    schemaname?: string,
    filter?: string
  ): Promise<unknown> {
    return this.json("POST", "/api/metadata/set", { schemaname, filter }, metadata);
  }

  /** GET /api/users — list users (read-only). */
  async listUsers(params: {
    search?: string;
    skip?: number;
    limit?: number;
    sort?: string;
    onlycount?: boolean;
    includedeleted?: boolean;
  }): Promise<unknown> {
    return this.json("GET", "/api/users", {
      search: params.search,
      skip: params.skip?.toString(),
      limit: params.limit?.toString(),
      sort: params.sort,
      onlycount: params.onlycount ? "true" : undefined,
      includedeleted: params.includedeleted ? "true" : undefined,
    });
  }

  /** GET /api/users/{id} — a single user (read-only). */
  async getUser(id: string): Promise<unknown> {
    return this.json("GET", `/api/users/${encodeURIComponent(id)}`);
  }

  /** GET /api/roles — list roles (read-only). */
  async listRoles(): Promise<unknown> {
    return this.json("GET", "/api/roles");
  }

  /** GET /api/roles/{id} — a single role (read-only). */
  async getRole(id: string): Promise<unknown> {
    return this.json("GET", `/api/roles/${encodeURIComponent(id)}`);
  }
}
