import { execFileSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;

/** Raised when the local Docker CLI or daemon is unusable. */
export class DockerUnavailableError extends Error {
  override readonly name = "DockerUnavailableError";
}

/**
 * Runs `docker` with the given arguments and returns trimmed stdout.
 * Throws with the captured stderr when the command fails.
 */
export function docker(args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`docker ${args.join(" ")} failed: ${describeDockerFailure(error)}`);
  }
}

/** Runs `docker`, returning `null` instead of throwing when the command fails. */
export function tryDocker(args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): string | null {
  try {
    return docker(args, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Fails fast with an actionable message when Docker is missing or its daemon is
 * unreachable. Tests must never fall back to a user-managed MongoDB.
 */
export function assertDockerAvailable(): void {
  try {
    docker(["--version"], 15_000);
  } catch {
    throw new DockerUnavailableError(
      "the Docker CLI is required for local MongoDB tests; install Docker and make sure `docker --version` succeeds",
    );
  }

  try {
    docker(["info", "--format", "{{.ServerVersion}}"], 30_000);
  } catch {
    throw new DockerUnavailableError(
      "the Docker daemon is not reachable; start Docker before running MongoDB integration or E2E tests",
    );
  }
}

function describeDockerFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) {
      return stderr.trim();
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}
