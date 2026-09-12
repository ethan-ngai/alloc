import { describe, expect, it, vi } from "vitest";
import { LocalOnlyJsonTransport, validateLocalModelEndpoint } from "../src/index.js";

const endpoint = { baseUrl: "http://127.0.0.1:8080/v1/", modelId: "Qwen3.8-27B@sha256:example" };

describe("local-only model transport", () => {
  it("accepts numeric loopback hosts and rejects hosted, credentialed, or DNS-based URLs", () => {
    expect(validateLocalModelEndpoint(endpoint).baseUrl).toBe(endpoint.baseUrl);
    expect(validateLocalModelEndpoint({ ...endpoint, baseUrl: "http://[::1]:8080/v1" }).baseUrl).toContain("[::1]");
    for (const baseUrl of [
      "https://api.example.com/v1",
      "http://localhost:8080/v1",
      "http://localhost.evil.example/v1",
      "http://user:password@127.0.0.1:8080/v1",
      "file:///tmp/model.sock",
    ]) {
      expect(() => validateLocalModelEndpoint({ ...endpoint, baseUrl })).toThrowError(
        expect.objectContaining({ code: "INVALID_LOCAL_ENDPOINT" }),
      );
    }
  });

  it("posts JSON locally with redirects disabled", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const transport = new LocalOnlyJsonTransport({ endpoint, maxResponseBytes: 1_024, fetchImpl });
    await expect(transport.post("chat/completions", { model: endpoint.modelId })).resolves.toEqual({ choices: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8080/v1/chat/completions"),
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("rejects an absolute hosted path before fetch and refuses redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://api.example.com/v1" },
    }));
    const transport = new LocalOnlyJsonTransport({ endpoint, maxResponseBytes: 1_024, fetchImpl });
    await expect(transport.post("https://api.example.com/v1/chat", {})).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_LOCAL_ENDPOINT" }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(transport.post("chat/completions", {})).rejects.toEqual(
      expect.objectContaining({ code: "REDIRECT_DENIED" }),
    );
  });

  it("bounds actual response bytes and rejects malformed JSON", async () => {
    const oversized = new LocalOnlyJsonTransport({
      endpoint,
      maxResponseBytes: 4,
      fetchImpl: async () => new Response("12345", { status: 200 }),
    });
    await expect(oversized.post("chat/completions", {})).rejects.toEqual(
      expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }),
    );

    const malformed = new LocalOnlyJsonTransport({
      endpoint,
      maxResponseBytes: 100,
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    });
    await expect(malformed.post("chat/completions", {})).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_JSON" }),
    );
  });
});
