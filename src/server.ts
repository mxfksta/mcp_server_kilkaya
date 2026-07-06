import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KilkayaApiError, KilkayaClient } from "./kilkaya.js";

export interface ServerConfig {
  kilkayaToken: string;
  kilkayaBaseUrl?: string;
  queryTimeoutMs?: number;
  /** Expose kilkaya_set_metadata (writes article metadata into Kilkaya). */
  enableWriteTools: boolean;
  /** Expose read-only user/role tools (user data contains emails/PII). */
  enableAdminTools: boolean;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function jsonResult(data: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown): ToolResult {
  const message =
    error instanceof KilkayaApiError
      ? `${error.message}\n${error.body}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}

const filterSchema = z.object({
  column: z.string().describe("Field name to filter on (must be a valid field of the schema)"),
  operator: z
    .enum(["like", "notlike", "greater", "less"])
    .describe("Filter operator. 'like'/'notlike' support wildcards with *, not %"),
  value: z.union([z.string(), z.number()]).describe("Value to compare against"),
});

/**
 * Builds a fresh McpServer instance. With the stateless Streamable HTTP
 * transport a new instance is created per request, so this must stay cheap
 * (no I/O at build time).
 */
export function buildServer(config: ServerConfig): McpServer {
  const client = new KilkayaClient(config.kilkayaToken, {
    baseUrl: config.kilkayaBaseUrl,
    queryTimeoutMs: config.queryTimeoutMs,
  });

  const server = new McpServer({ name: "kilkaya", version: "0.1.0" });

  server.registerTool(
    "kilkaya_query",
    {
      title: "Run Kilkaya analytics query",
      description:
        "Run a query against the Kilkaya analytics API (POST /api/query). " +
        "Returns data in JSON:API format. Use kilkaya_list_schemas first to discover " +
        "valid schema names and their fields ('allfields' is the authoritative field list). " +
        "Time fields such as _minute, _day or _month can be added to 'columns' to split the " +
        "result by time (e.g. per day). Long-running queries are polled automatically; if the " +
        "query is still running when the timeout is reached, the queue status is returned and " +
        "the identical query can simply be sent again.",
      inputSchema: {
        schemaname: z
          .string()
          .describe("Schema to query, e.g. 'pageviews'. See kilkaya_list_schemas"),
        datefrom: z
          .string()
          .describe(
            "Start of the date range, ISO 8601 with or without timezone, e.g. '2021-02-16T11:00:00+00:00'. Without timezone the customer's timezone is used"
          ),
        dateto: z.string().describe("End of the date range, same format as datefrom"),
        columns: z
          .array(z.string())
          .min(1)
          .describe(
            "Fields to return, e.g. ['url', 'pageviews', 'section']. Optionally include a time field (_minute, _day, _month) to split by time"
          ),
        filters: z.array(filterSchema).optional().describe("Optional filters (AND-combined)"),
        sortby: z.array(z.string()).optional().describe("Fields to sort by"),
        sortorder: z
          .array(z.enum(["asc", "desc"]))
          .optional()
          .describe("Sort direction per sortby entry"),
        limit: z.number().int().positive().optional().describe("Max rows to return, e.g. 100"),
        skip: z.number().int().min(0).optional().describe("Rows to skip (pagination)"),
      },
    },
    async (args) =>
      run(async () => {
        const { pending, result } = await client.query(args);
        if (pending) {
          return {
            note:
              "The query is still queued/running on the Kilkaya side. " +
              "Re-run this exact tool call to continue polling for the result.",
            status: result,
          };
        }
        return result;
      })
  );

  server.registerTool(
    "kilkaya_list_schemas",
    {
      title: "List Kilkaya schemas",
      description:
        "List available Kilkaya schemas and their field definitions (GET /api/schemas). " +
        "'allfields' is the authoritative list of valid fields for kilkaya_query columns and " +
        "filters. 'timefields' lists the time aggregations (_minute, _day, _month, ...) that " +
        "can be added as columns. 'numberfields' and 'fieldaggregations' are informational " +
        "only and must not be used as column names.",
      inputSchema: {
        schemaname: z
          .string()
          .optional()
          .describe("Fetch only this schema; use 'default' for the default schema"),
        version: z
          .string()
          .optional()
          .describe("Highest schema version to use, format YYYYMMDD, e.g. 20260625"),
      },
    },
    async ({ schemaname, version }) => run(() => client.listSchemas(schemaname, version))
  );

  server.registerTool(
    "kilkaya_get_metadata",
    {
      title: "Get article metadata",
      description:
        "Get stored metadata (title, author, publishtime, ...) for a single article url " +
        "(GET /api/metadata). The url must be given without protocol, e.g. 'example.com/news/abc123'.",
      inputSchema: {
        url: z.string().describe("Article url without protocol, e.g. 'example.com/news/abc123'"),
      },
    },
    async ({ url }) => run(() => client.getMetadata(url))
  );

  server.registerTool(
    "kilkaya_get_metadata_bulk",
    {
      title: "Get article metadata for many urls",
      description:
        "Get stored metadata for many article urls in one call (POST /api/metadata). " +
        "Urls must be given without protocol.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(1)
          .describe("Article urls without protocol, e.g. ['example.com/news/abc123']"),
      },
    },
    async ({ urls }) => run(() => client.getMetadataBulk(urls))
  );

  if (config.enableWriteTools) {
    server.registerTool(
      "kilkaya_set_metadata",
      {
        title: "Store article metadata",
        description:
          "Store or update metadata for a given article url in Kilkaya (POST /api/metadata/set). " +
          "This writes data into Kilkaya.",
        inputSchema: {
          url: z.string().describe("Article url, e.g. 'example.com/news/abc123'"),
          title: z.string().optional().describe("Article title"),
          author: z.array(z.string()).optional().describe("Author name(s)"),
          publishtime: z
            .string()
            .optional()
            .describe("Publish time, ISO 8601, e.g. '2025-06-16T10:00:00Z'"),
          extra: z
            .record(z.unknown())
            .optional()
            .describe("Additional metadata fields to store, merged into the payload"),
          schemaname: z.string().optional().describe("Schema to store the metadata in"),
          normalizeUrl: z
            .boolean()
            .optional()
            .describe("If true, the url is normalized before storing (filter=1)"),
        },
      },
      async ({ url, title, author, publishtime, extra, schemaname, normalizeUrl }) =>
        run(() =>
          client.setMetadata(
            {
              url,
              ...(title !== undefined ? { title } : {}),
              ...(author !== undefined ? { author } : {}),
              ...(publishtime !== undefined ? { publishtime } : {}),
              ...(extra ?? {}),
            },
            schemaname,
            normalizeUrl ? "1" : undefined
          )
        )
    );
  }

  if (config.enableAdminTools) {
    server.registerTool(
      "kilkaya_list_users",
      {
        title: "List Kilkaya users",
        description:
          "List Kilkaya users (GET /api/users, read-only). Supports regex search in name, " +
          "email and roles.",
        inputSchema: {
          search: z.string().optional().describe("Regex search in name, email and roles"),
          skip: z.number().int().min(0).optional().describe("Number of rows to skip"),
          limit: z.number().int().positive().optional().describe("Limit result rows"),
          sort: z
            .string()
            .optional()
            .describe("Sort on field, prefix with '-' for descending"),
          onlycount: z.boolean().optional().describe("Only return the count"),
          includedeleted: z.boolean().optional().describe("Also include deleted users"),
        },
      },
      async (args) => run(() => client.listUsers(args))
    );

    server.registerTool(
      "kilkaya_get_user",
      {
        title: "Get Kilkaya user",
        description: "Get a single Kilkaya user by id (GET /api/users/{id}, read-only).",
        inputSchema: { id: z.string().describe("The user id") },
      },
      async ({ id }) => run(() => client.getUser(id))
    );

    server.registerTool(
      "kilkaya_list_roles",
      {
        title: "List Kilkaya roles",
        description:
          "List Kilkaya roles with their ACLs, schemas and filter rules (GET /api/roles, read-only).",
        inputSchema: {},
      },
      async () => run(() => client.listRoles())
    );

    server.registerTool(
      "kilkaya_get_role",
      {
        title: "Get Kilkaya role",
        description: "Get a single Kilkaya role by id (GET /api/roles/{id}, read-only).",
        inputSchema: { id: z.string().describe("The role id") },
      },
      async ({ id }) => run(() => client.getRole(id))
    );
  }

  return server;
}
