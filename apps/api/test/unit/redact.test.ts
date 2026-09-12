import { describe, expect, it } from "vitest";
import { describeError } from "../../src/errors.js";
import { redactMongoUri, redactText } from "../../src/redact.js";

describe("redactMongoUri", () => {
  it("removes embedded credentials and keeps the rest of the URI", () => {
    expect(redactMongoUri("mongodb://alloc_admin:hunter2@127.0.0.1:27017/?replicaSet=alloc")).toBe(
      "mongodb://[redacted]@127.0.0.1:27017/?replicaSet=alloc",
    );
    expect(redactMongoUri("mongodb+srv://user:pass@cluster.example/alloc")).toBe(
      "mongodb+srv://[redacted]@cluster.example/alloc",
    );
    expect(redactMongoUri("mongodb://127.0.0.1:27017/?replicaSet=alloc")).toBe(
      "mongodb://127.0.0.1:27017/?replicaSet=alloc",
    );
  });
});

describe("redactText", () => {
  it("removes configured secret values and connection-string credentials", () => {
    const secret = "configuration-test-secret-32-bytes-minimum";
    const text = `driver rejected ${secret} while connecting to mongodb://admin:hunter2@127.0.0.1:27017`;

    const redacted = redactText(text, [secret]);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("[redacted]@127.0.0.1:27017");
  });

  it("ignores empty secrets", () => {
    expect(redactText("plain message", [""])).toBe("plain message");
  });
});

describe("describeError", () => {
  it("returns a log-safe view of a failure", () => {
    const secret = "configuration-test-secret-32-bytes-minimum";
    const described = describeError(new TypeError(`bad ${secret}`), (text) => redactText(text, [secret]));

    expect(described.name).toBe("TypeError");
    expect(described.message).toBe("bad [redacted]");
    expect(described.stack).not.toContain(secret);
  });

  it("normalizes non-error values", () => {
    expect(describeError("boom", (text) => text).message).toBe("boom");
    expect(describeError({ weird: true }, (text) => text).message).toBe("unknown error");
  });
});
