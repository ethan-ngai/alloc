#!/usr/bin/env node
import { DEFAULT_MOCK_PORT, createMockApi } from "./api.js";
import { DEFAULT_MOCK_CLOCK } from "./clock.js";
import { MockContractError } from "./errors.js";

const USAGE = `Usage: alloc-mock-api [options]

Options:
  --port <number>   port to bind (default ${DEFAULT_MOCK_PORT}, or MOCK_API_PORT)
  --host <address>  address to bind (default 127.0.0.1, or MOCK_API_HOST)
  --clock <instant> logical clock start (default ${DEFAULT_MOCK_CLOCK}, or MOCK_CLOCK)
  --quiet           do not print the startup line
  --help            print this message
`;

interface CliOptions {
  port: number;
  host: string;
  clock: string;
  quiet: boolean;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new MockContractError("VALIDATION_FAILED", `invalid port: ${value}`);
  }
  return port;
}

function parseArgs(argv: readonly string[]): CliOptions | "help" {
  const options: CliOptions = {
    port: process.env["MOCK_API_PORT"] === undefined ? DEFAULT_MOCK_PORT : parsePort(process.env["MOCK_API_PORT"]),
    host: process.env["MOCK_API_HOST"] ?? "127.0.0.1",
    clock: process.env["MOCK_CLOCK"] ?? DEFAULT_MOCK_CLOCK,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inlineValue] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined) throw new MockContractError("VALIDATION_FAILED", `${flag} requires a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--help":
        return "help";
      case "--quiet":
        options.quiet = true;
        break;
      case "--port":
        options.port = parsePort(value());
        break;
      case "--host":
        options.host = value();
        break;
      case "--clock":
        options.clock = value();
        break;
      default:
        throw new MockContractError("VALIDATION_FAILED", `unknown flag: ${arg}`);
    }
  }
  return options;
}

let parsed: CliOptions | "help";
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
if (parsed === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

const api = createMockApi({ clock: parsed.clock });
const { url } = await api.listen(parsed.port, parsed.host);
if (!parsed.quiet) {
  process.stdout.write(
    `alloc-mock-api listening on ${url} clock=${api.health().clock} organizations=${api.store.organizations.join(",")}\n`,
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void api.close().then(() => process.exit(0));
  });
}
