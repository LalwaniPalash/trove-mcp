#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import cors from "cors";
import { loadConfig, type AppConfig } from "./lib/core/config.js";
import { createContext } from "./lib/core/context.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";

type Mode = "stdio" | "http" | "sync";

function parseMode(argv: string[]): Mode {
  if (argv[0] === "sync") {
    return "sync";
  }

  const transportArg = argv.find((arg) => arg.startsWith("--transport="));
  const explicit = transportArg?.split("=")[1];
  const envTransport = process.env.TROVE_TRANSPORT;
  const value = explicit ?? envTransport ?? "stdio";
  return value === "http" ? "http" : "stdio";
}

function parsePort(argv: string[], fallback: number): number {
  const portArg = argv.find((arg) => arg.startsWith("--port="));
  if (!portArg) {
    return fallback;
  }
  const parsed = Number(portArg.split("=")[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSyncQueries(argv: string[]): string[] {
  const queriesArg = argv.find((arg) => arg.startsWith("--queries="));
  if (!queriesArg) {
    return ["machine learning", "genomics", "econometrics"];
  }

  return queriesArg
    .split("=")[1]
    .split(",")
    .map((query) => query.trim())
    .filter(Boolean);
}

function buildServer(config: AppConfig, ctx: ReturnType<typeof createContext>): McpServer {
  const server = new McpServer({
    name: "trove-mcp",
    version: config.version,
  });

  registerTools(server, ctx, config.disabledTools);
  registerResources(server, ctx);
  registerPrompts(server, config.disabledTools);

  return server;
}

async function runSyncMode(ctx: ReturnType<typeof createContext>, argv: string[]): Promise<void> {
  const queries = parseSyncQueries(argv);
  const result = await ctx.service.syncSnapshots(queries);
  console.error(JSON.stringify({ mode: "sync", ...result }, null, 2));
  ctx.repo.close();
}

async function runStdioMode(config: AppConfig, ctx: ReturnType<typeof createContext>): Promise<void> {
  const server = buildServer(config, ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttpMode(
  config: AppConfig,
  ctx: ReturnType<typeof createContext>,
  port: number,
): Promise<void> {
  if (!config.http.bearerToken) {
    console.error(
      "[error] TROVE_HTTP_BEARER_TOKEN is required in HTTP mode.\n" +
        "Set TROVE_HTTP_BEARER_TOKEN in your environment and restart.",
    );
    process.exit(1);
  }

  const app = createMcpExpressApp({ host: config.http.host });

  const corsOptions: cors.CorsOptions = {
    origin: config.http.corsOrigin,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "MCP-Protocol-Version",
      "MCP-Session-Id",
      "Mcp-Session-Id",
      "Last-Event-ID",
    ],
    exposedHeaders: ["MCP-Session-Id", "Mcp-Session-Id"],
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));
  app.options("/mcp", cors(corsOptions));

  app.use("/mcp", (req, res, next) => {
    if (req.method === "OPTIONS") {
      next();
      return;
    }

    const auth = req.header("authorization");
    const expected = `Bearer ${config.http.bearerToken}`;
    if (auth !== expected) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized",
        },
        id: null,
      });
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "trove-mcp",
      version: config.version,
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/mcp", async (req, res) => {
    const server = buildServer(config, ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", async () => {
        await transport.close();
        await server.close();
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "HTTP MCP request failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      }),
    );
  });

  app.delete("/mcp", async (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      }),
    );
  });

  app.listen(port, config.http.host, () => {
    console.error(
      JSON.stringify({
        level: "info",
        message: "trove-mcp HTTP server listening",
        host: config.http.host,
        port,
      }),
    );
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = parseMode(argv);
  const config = loadConfig();
  const ctx = createContext(config);

  if (mode === "sync") {
    await runSyncMode(ctx, argv);
    return;
  }

  if (mode === "http") {
    const port = parsePort(argv, config.http.port);
    await runHttpMode(config, ctx, port);
    return;
  }

  await runStdioMode(config, ctx);
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "fatal startup error",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
