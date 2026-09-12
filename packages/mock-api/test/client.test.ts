import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_STATUS } from "../src/errors.js";
import { ContractClientError, createContractClient } from "../src/index.js";
import { northstarPack } from "../src/packs.js";
import { commandMeta, companyFixture, expectClientError, postOperation, queryMeta, startMock } from "./harness.js";

const SOURCE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Walks the `.` entry graph through its relative imports, which is where a `node:*` leak would hide. */
async function walkEntryGraph(specifier: string, visited: Set<string>, builtins: string[]): Promise<void> {
  const path = resolve(SOURCE_DIRECTORY, specifier);
  if (visited.has(path)) return;
  visited.add(path);
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/(?:import|export)[^"'`]*?from\s+["']([^"']+)["']/g)) {
    const dependency = match[1]!;
    if (dependency.startsWith("node:")) builtins.push(`${specifier} -> ${dependency}`);
    else if (dependency.startsWith(".")) await walkEntryGraph(dependency.replace(/\.js$/, ".ts"), visited, builtins);
  }
}

const company = companyFixture(northstarPack);

const getRequest = {
  meta: queryMeta("correlation_client_get", company.organizationId),
  payload: { requestId: company.requestId },
};

const missingRequest = {
  meta: queryMeta("correlation_client_missing", company.organizationId),
  payload: { requestId: "request_client_missing" },
};

async function startStub(body: string, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

describe("typed contract client", () => {
  it("returns the parsed envelope for an ok and an error response and matches the status table", async () => {
    const { api, url } = await startMock();
    try {
      const client = createContractClient({ baseUrl: url });

      const ok = await client.call("requests.get", getRequest);
      expect(ok.ok).toBe(true);
      expect(ok.schemaVersion).toBe("1.0.0");
      if (!ok.ok) throw new Error("expected an ok envelope");
      expect(ok.data.request.revision).toBe(1);
      expect(ok.data.commitment?.outstandingAmount.amountMinor).toBe(18_000);

      const failure = await client.call("requests.get", missingRequest);
      expect(failure.ok).toBe(false);
      if (failure.ok) throw new Error("expected a failure envelope");
      expect(failure.error.code).toBe("NOT_FOUND");
      const { status } = await postOperation(url, "requests.get", missingRequest);
      expect(status).toBe(ERROR_STATUS[failure.error.code]);
      expect(status).toBe(404);
    } finally {
      await api.close();
    }
  });

  it("throws ContractClientError carrying code, retryable, status, and correlationId from expect", async () => {
    const { api, url } = await startMock();
    try {
      const client = createContractClient({ baseUrl: url, principalId: company.requesterId });
      const error = await expectClientError(client.expect("reviews.decide", {
        meta: commandMeta("command_client_authority", "correlation_client_authority", company.organizationId),
        payload: { requestId: company.requestId, requestRevision: 1, outcome: "approved", rationale: "Self approval" },
      }));
      expect(error).toBeInstanceOf(ContractClientError);
      expect(error.code).toBe("AUTHORITY_DENIED");
      expect(error.retryable).toBe(false);
      expect(error.status).toBe(ERROR_STATUS.AUTHORITY_DENIED);
      expect(error.correlationId).toBe("correlation_client_authority");
      expect(error.details).toEqual({ authorityRole: null });
    } finally {
      await api.close();
    }
  });

  it("rejects a body that does not satisfy the response contract", async () => {
    const stub = await startStub(JSON.stringify({ ok: true }));
    try {
      const client = createContractClient({ baseUrl: stub.url });
      const fromCall = await expectClientError(client.call("requests.get", getRequest));
      expect(fromCall.code).toBe("INTERNAL_ERROR");
      expect(fromCall.details).toBeDefined();
      const fromExpect = await expectClientError(client.expect("requests.get", getRequest));
      expect(fromExpect.code).toBe("INTERNAL_ERROR");
    } finally {
      await stub.close();
    }
  });

  it("rejects a non-JSON body as an internal contract violation", async () => {
    const stub = await startStub("not json at all");
    try {
      const client = createContractClient({ baseUrl: stub.url });
      const error = await expectClientError(client.call("requests.get", getRequest));
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.status).toBe(200);
    } finally {
      await stub.close();
    }
  });

  it("reports a closed port as a retryable DEPENDENCY_UNAVAILABLE with status 0", async () => {
    const { api, url } = await startMock();
    await api.close();
    const client = createContractClient({ baseUrl: url, timeoutMs: 2_000 });
    const error = await expectClientError(client.call("requests.get", getRequest));
    expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(0);
  });
  it("keeps the browser entry graph free of node built-ins", async () => {
    const visited = new Set<string>();
    const builtins: string[] = [];
    await walkEntryGraph("index.ts", visited, builtins);
    expect(builtins).toEqual([]);
    const graph = [...visited].map((path) => path.slice(SOURCE_DIRECTORY.length + 1));
    expect(graph).toContain("index.ts");
    expect(graph).toContain("client.ts");
    expect(graph).toContain("errors.ts");
    expect(graph).toContain("operations.ts");
    expect(graph.some((path) => path.startsWith("api."))).toBe(false);
  });
});
