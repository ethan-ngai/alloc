import { CONTRACT_SCHEMA_VERSION } from "@alloc/contracts";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { MOCK_FAULT_HEADER, MOCK_PRINCIPAL_HEADER } from "./client.js";
import { DEFAULT_MOCK_CLOCK } from "./clock.js";
import type { Clock } from "./clock.js";
import { MockContractError, errorStatus, isRetryable } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { createCompanyPacks } from "./packs.js";
import type { CompanyPack } from "./packs.js";
import { UNPARSED_CORRELATION_ID, dispatch } from "./router.js";
import { createMockStore } from "./store.js";
import type { MockHealth, MockStore } from "./store.js";

export const DEFAULT_MOCK_PORT = 4310;
export const MAX_REQUEST_BYTES = 1_048_576;

const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": `content-type, ${MOCK_PRINCIPAL_HEADER}, ${MOCK_FAULT_HEADER}`,
  "access-control-max-age": "600",
});

export interface MockApiOptions {
  clock?: string;
  packs?: CompanyPack[];
}

export interface MockApi {
  store: MockStore;
  packs: readonly CompanyPack[];
  clock: Clock;
  handle(req: IncomingMessage, res: ServerResponse): void;
  listen(port?: number, host?: string): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
  reset(organizationId?: string): void;
  health(): MockHealth;
}

function sendJson(res: ServerResponse, status: number, body: unknown, onFlushed?: () => void): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload, onFlushed);
}

function faultEnvelope(code: ErrorCode, message: string, details?: Record<string, unknown>): unknown {
  return {
    ok: false,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    correlationId: UNPARSED_CORRELATION_ID,
    error: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      code,
      message,
      retryable: isRetryable(code),
      correlationId: UNPARSED_CORRELATION_ID,
      ...(details === undefined ? {} : { details }),
    },
  };
}

/**
 * The mock runs as a real HTTP server so the frontend and the tests exercise the same surface: the
 * eleven `POST /operations/<name>` routes, CORS for a Vite dev origin, health, and admin reset. It
 * binds `127.0.0.1` by default and never reaches the network itself.
 */
export function createMockApi(options: MockApiOptions = {}): MockApi {
  const clockStart = options.clock ?? DEFAULT_MOCK_CLOCK;
  const packs = options.packs ?? createCompanyPacks(clockStart);
  const store = createMockStore({ clock: clockStart, packs });
  const sockets = new Set<Socket>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://mock.invalid").pathname;

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (method === "GET" && path === "/health") {
      sendJson(res, 200, store.health());
      return;
    }

    const isOperationRoute = path.startsWith("/operations/");
    if (method === "POST" && (path === "/admin/reset" || isOperationRoute)) {
      const body = await readBody(req);
      if (body === null) {
        res.setHeader("connection", "close");
        sendJson(
          res,
          errorStatus("VALIDATION_FAILED"),
          faultEnvelope("VALIDATION_FAILED", `request body exceeds ${MAX_REQUEST_BYTES} bytes`, { reasonCode: "requestBodyTooLarge", maxBytes: MAX_REQUEST_BYTES }),
          () => req.destroy(),
        );
        return;
      }
      if (isOperationRoute) {
        let operation: string;
        try {
          operation = decodeURIComponent(path.slice("/operations/".length));
        } catch {
          sendJson(
            res,
            errorStatus("VALIDATION_FAILED"),
            faultEnvelope("VALIDATION_FAILED", "operation path is not valid percent encoding", { reasonCode: "malformedOperationPath" }),
          );
          return;
        }
        const reply = dispatch(store, operation, body, {
          ...(req.headers[MOCK_PRINCIPAL_HEADER] === undefined ? {} : { principalId: String(req.headers[MOCK_PRINCIPAL_HEADER]) }),
          ...(req.headers[MOCK_FAULT_HEADER] === undefined ? {} : { fault: String(req.headers[MOCK_FAULT_HEADER]) }),
        });
        sendJson(res, reply.status, reply.body);
        return;
      }
      try {
        const parsed = body.trim() === "" ? {} : JSON.parse(body);
        const organizationId = parsed !== null && typeof parsed === "object" && "organizationId" in parsed
          ? parsed.organizationId
          : undefined;
        if (organizationId !== undefined && typeof organizationId !== "string") {
          sendJson(res, errorStatus("VALIDATION_FAILED"), faultEnvelope("VALIDATION_FAILED", "organizationId must be a string", { reasonCode: "invalidOrganizationId" }));
          return;
        }
        store.reset(organizationId);
        sendJson(res, 200, { status: "reset", organizations: store.organizations });
      } catch (error) {
        if (error instanceof MockContractError) {
          sendJson(res, errorStatus(error.code), faultEnvelope(error.code, error.message, error.details));
          return;
        }
        sendJson(res, errorStatus("VALIDATION_FAILED"), faultEnvelope("VALIDATION_FAILED", "reset body is not valid JSON", { reasonCode: "malformedJson" }));
      }
      return;
    }

    sendJson(res, errorStatus("NOT_FOUND"), faultEnvelope("NOT_FOUND", `no operation route for ${method} ${path}`, { method, path }));
  };

  const safelyHandleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res).catch(() => {
      try {
        if (res.writableEnded) return;
        if (!res.headersSent) {
          sendJson(res, errorStatus("INTERNAL_ERROR"), faultEnvelope("INTERNAL_ERROR", "unexpected mock failure"));
          return;
        }
        res.destroy();
      } catch {
        res.destroy();
      }
    });
  };

  const server: Server = createServer((req, res) => {
    safelyHandleRequest(req, res);
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    store,
    packs,
    clock: store.clock,
    handle(req, res) {
      safelyHandleRequest(req, res);
    },
    async listen(port = DEFAULT_MOCK_PORT, host = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
      const address = server.address();
      const boundPort = address !== null && typeof address === "object" ? address.port : port;
      return { url: `http://${host}:${boundPort}`, port: boundPort };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
    reset(organizationId) {
      store.reset(organizationId);
    },
    health() {
      return store.health();
    },
  };
}

/** Returns `null` when the body exceeds `MAX_REQUEST_BYTES`. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
