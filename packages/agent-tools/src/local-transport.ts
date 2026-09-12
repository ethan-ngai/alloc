export type LocalTransportErrorCode =
  | "INVALID_LOCAL_ENDPOINT"
  | "REDIRECT_DENIED"
  | "HTTP_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_JSON";

export class LocalTransportError extends Error {
  constructor(readonly code: LocalTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalTransportError";
  }
}

export interface LocalModelEndpoint {
  baseUrl: string;
  modelId: string;
}

export interface LocalJsonTransportOptions {
  endpoint: LocalModelEndpoint;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response byte limit exceeded");
      throw new LocalTransportError("RESPONSE_TOO_LARGE", "local model response exceeds its byte limit");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function validateLocalModelEndpoint(input: LocalModelEndpoint): LocalModelEndpoint {
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch (error) {
    throw new LocalTransportError("INVALID_LOCAL_ENDPOINT", "model endpoint is not a valid URL", { cause: error });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new LocalTransportError(
      "INVALID_LOCAL_ENDPOINT",
      "model endpoint must be an explicit credential-free loopback HTTP(S) URL",
    );
  }
  if (input.modelId.trim() === "" || input.modelId.length > 500) {
    throw new LocalTransportError("INVALID_LOCAL_ENDPOINT", "modelId must be an explicit bounded local model identifier");
  }
  return { baseUrl: url.toString(), modelId: input.modelId };
}

export class LocalOnlyJsonTransport {
  readonly endpoint: LocalModelEndpoint;
  readonly #fetch: typeof fetch;

  constructor(readonly options: LocalJsonTransportOptions) {
    this.endpoint = validateLocalModelEndpoint(options.endpoint);
    if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) {
      throw new RangeError("maxResponseBytes must be a positive safe integer");
    }
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const target = new URL(path, this.endpoint.baseUrl);
    validateLocalModelEndpoint({ baseUrl: target.toString(), modelId: this.endpoint.modelId });
    if (target.origin !== new URL(this.endpoint.baseUrl).origin) {
      throw new LocalTransportError("INVALID_LOCAL_ENDPOINT", "request cannot change the configured local origin");
    }

    const response = await this.#fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new LocalTransportError("REDIRECT_DENIED", "model endpoint redirects are disabled");
    }
    if (!response.ok) {
      throw new LocalTransportError("HTTP_ERROR", `local model endpoint returned HTTP ${response.status}`);
    }

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > this.options.maxResponseBytes) {
      throw new LocalTransportError("RESPONSE_TOO_LARGE", "local model response exceeds its byte limit");
    }
    const bytes = await readBoundedBody(response, this.options.maxResponseBytes);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new LocalTransportError("INVALID_JSON", "local model response is not valid JSON", { cause: error });
    }
  }
}
