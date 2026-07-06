import express, { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, ServerConfig } from "./server.js";

const kilkayaToken = process.env.KILKAYA_API_TOKEN;
if (!kilkayaToken) {
  console.error("Missing required environment variable KILKAYA_API_TOKEN");
  process.exit(1);
}

const config: ServerConfig = {
  kilkayaToken,
  kilkayaBaseUrl: process.env.KILKAYA_BASE_URL,
  queryTimeoutMs: process.env.KILKAYA_QUERY_TIMEOUT_MS
    ? parseInt(process.env.KILKAYA_QUERY_TIMEOUT_MS, 10)
    : undefined,
  enableWriteTools: process.env.KILKAYA_ENABLE_WRITE_TOOLS === "true",
  enableAdminTools: process.env.KILKAYA_ENABLE_ADMIN_TOOLS === "true",
};

// Optional shared secret protecting the MCP endpoint itself. On Cloud Run
// you can alternatively (or additionally) require IAM authentication.
const mcpAuthToken = process.env.MCP_AUTH_TOKEN;

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!mcpAuthToken) return next();
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${mcpAuthToken}`) return next();
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
}

// Stateless mode: a fresh server + transport per request, no session state.
// This lets Cloud Run scale to any number of instances (including zero).
app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  const server = buildServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// In stateless mode there are no server-initiated streams or sessions.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = parseInt(process.env.PORT ?? "8080", 10);
app.listen(port, "0.0.0.0", () => {
  console.log(`Kilkaya MCP server listening on port ${port} (endpoint: /mcp)`);
  console.log(
    `Write tools: ${config.enableWriteTools ? "enabled" : "disabled"}, ` +
      `admin tools: ${config.enableAdminTools ? "enabled" : "disabled"}, ` +
      `endpoint auth: ${mcpAuthToken ? "bearer token" : "none (rely on platform auth)"}`
  );
});
