#!/usr/bin/env python3
"""Collect reproducible GB10/model evidence and probe a local tool-call endpoint."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse


DECIMAL_GB = 1_000_000_000
WEIGHT_SUFFIXES = {".bin", ".gguf", ".pt", ".pth", ".safetensors"}
DEFAULT_MODEL_ID = "Qwen/Qwen3.8-Flash-Next"


@dataclass(frozen=True)
class MemoryBudget:
    total_bytes: int
    available_bytes: int | None
    checkpoint_bytes: int
    os_application_bytes: int = 16 * DECIMAL_GB
    maximum_weight_bytes: int = 90 * DECIMAL_GB
    runtime_bytes: int = 10 * DECIMAL_GB
    minimum_headroom_bytes: int = 12 * DECIMAL_GB

    def evaluate(self) -> dict[str, Any]:
        planned = self.os_application_bytes + self.checkpoint_bytes + self.runtime_bytes
        projected_headroom = self.total_bytes - planned
        checks = {
            "checkpoint_within_weight_envelope": self.checkpoint_bytes
            <= self.maximum_weight_bytes,
            "projected_headroom_meets_minimum": projected_headroom
            >= self.minimum_headroom_bytes,
            "currently_available_for_checkpoint_and_runtime": (
                self.available_bytes is not None
                and self.available_bytes >= self.checkpoint_bytes + self.runtime_bytes
            ),
        }
        return {
            "inputs": asdict(self),
            "planned_bytes": planned,
            "projected_headroom_bytes": projected_headroom,
            "checks": checks,
            "passes_static_envelope": all(
                checks[name]
                for name in (
                    "checkpoint_within_weight_envelope",
                    "projected_headroom_meets_minimum",
                )
            ),
            "qualification": (
                "static_estimate_only; a successful model load and peak-memory measurement "
                "are still required"
            ),
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_version(command: list[str]) -> dict[str, Any]:
    executable = shutil.which(command[0])
    if executable is None:
        return {"available": False}
    try:
        result = subprocess.run(
            [executable, *command[1:]],
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": True, "error": str(exc)}
    output = (result.stdout or result.stderr).strip()
    return {
        "available": True,
        "exit_code": result.returncode,
        "output": output[:4000],
    }


def read_linux_memory() -> tuple[int, int | None] | None:
    path = Path("/proc/meminfo")
    if not path.is_file():
        return None
    values: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, value = line.split(":", 1)
        values[key] = int(value.strip().split()[0]) * 1024
    return values["MemTotal"], values.get("MemAvailable")


def read_macos_memory() -> tuple[int, int | None] | None:
    if platform.system() != "Darwin":
        return None
    try:
        total = subprocess.run(
            ["sysctl", "-n", "hw.memsize"],
            capture_output=True,
            check=True,
            text=True,
        )
        return int(total.stdout.strip()), None
    except (OSError, subprocess.CalledProcessError, ValueError):
        return read_posix_memory()


def read_posix_memory() -> tuple[int, int | None] | None:
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        page_count = os.sysconf("SC_PHYS_PAGES")
    except (OSError, ValueError):
        return None
    if page_size <= 0 or page_count <= 0:
        return None
    return page_size * page_count, None


def system_memory() -> tuple[int, int | None]:
    measured = read_linux_memory() or read_macos_memory() or read_posix_memory()
    if measured is None:
        raise RuntimeError("unsupported host: could not measure physical memory")
    return measured


def iter_artifact_files(checkpoint: Path) -> Iterable[Path]:
    if checkpoint.is_file():
        yield checkpoint
        return
    for path in sorted(checkpoint.rglob("*")):
        if path.is_file() and not path.is_symlink():
            yield path


def artifact_inventory(checkpoint: Path) -> dict[str, Any]:
    checkpoint = checkpoint.expanduser().resolve(strict=True)
    files = list(iter_artifact_files(checkpoint))
    if not files:
        raise ValueError(f"checkpoint has no regular files: {checkpoint}")

    logical_bytes = sum(path.stat().st_size for path in files)
    allocated_bytes = sum(
        getattr(path.stat(), "st_blocks", 0) * 512 for path in files
    )
    weights = [path for path in files if path.suffix.lower() in WEIGHT_SUFFIXES]
    root = checkpoint if checkpoint.is_dir() else checkpoint.parent
    manifest_lines = [
        f"{path.relative_to(root).as_posix()}\0{path.stat().st_size}\n" for path in files
    ]
    manifest_sha256 = hashlib.sha256("".join(manifest_lines).encode()).hexdigest()
    largest = sorted(files, key=lambda path: path.stat().st_size, reverse=True)[:20]
    return {
        "path": str(checkpoint),
        "file_count": len(files),
        "logical_bytes": logical_bytes,
        "allocated_bytes": allocated_bytes,
        "weight_file_count": len(weights),
        "weight_logical_bytes": sum(path.stat().st_size for path in weights),
        "manifest_sha256": manifest_sha256,
        "largest_files": [
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
            }
            for path in largest
        ],
        "note": "disk bytes are a lower-bound proxy; runtime residency must be measured",
    }


def gpu_inventory() -> dict[str, Any]:
    result = run_version(
        [
            "nvidia-smi",
            "--query-gpu=name,uuid,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ]
    )
    if not result.get("available") or result.get("exit_code") != 0:
        return result
    rows = []
    for line in result["output"].splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 4:
            rows.append(
                {
                    "name": parts[0],
                    "uuid": parts[1],
                    "reported_memory_mib": int(parts[2]),
                    "driver_version": parts[3],
                }
            )
    result["gpus"] = rows
    return result


def inspect_host(checkpoint: Path, model_id: str) -> dict[str, Any]:
    total, available = system_memory()
    artifact = artifact_inventory(checkpoint)
    disk = shutil.disk_usage(checkpoint.resolve())
    budget = MemoryBudget(
        total_bytes=total,
        available_bytes=available,
        checkpoint_bytes=artifact["logical_bytes"],
    ).evaluate()
    return {
        "schema_version": 1,
        "kind": "gb10_host_preflight",
        "captured_at": utc_now(),
        "model_id": model_id,
        "host": {
            "hostname": socket.gethostname(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "memory_total_bytes": total,
            "memory_available_bytes": available,
            "checkpoint_filesystem": {
                "total_bytes": disk.total,
                "used_bytes": disk.used,
                "free_bytes": disk.free,
            },
        },
        "gpu": gpu_inventory(),
        "software": {
            "docker": run_version(["docker", "version", "--format", "{{.Server.Version}}"]),
            "mongod": run_version(["mongod", "--version"]),
            "nvcc": run_version(["nvcc", "--version"]),
            "openclaw": run_version(["openclaw", "--version"]),
        },
        "checkpoint": artifact,
        "memory_budget": budget,
        "remaining_gates": [
            "load the exact checkpoint with the selected local server",
            "record idle and peak unified-memory usage",
            "restart the server and repeat the probe",
            "complete a structured tool call through OpenClaw",
            "demonstrate offline operation with no hosted fallback",
        ],
    }


def require_loopback(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("endpoint must be an absolute HTTP(S) URL")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port)}
    except socket.gaierror as exc:
        raise ValueError(f"endpoint hostname could not be resolved: {exc}") from exc
    if not addresses or any(not ipaddress.ip_address(address).is_loopback for address in addresses):
        raise ValueError("endpoint must resolve exclusively to loopback addresses")


def post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def probe_endpoint(base_url: str, model: str, timeout: float) -> dict[str, Any]:
    base_url = base_url.rstrip("/")
    require_loopback(base_url)
    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {
                "role": "user",
                "content": "Call report_probe with status exactly 'local-ok'.",
            }
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "report_probe",
                    "description": "Records the bounded local model probe result.",
                    "parameters": {
                        "type": "object",
                        "properties": {"status": {"const": "local-ok"}},
                        "required": ["status"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
        "tool_choice": {"type": "function", "function": {"name": "report_probe"}},
    }
    started = time.monotonic()
    response = post_json(f"{base_url}/v1/chat/completions", payload, timeout)
    elapsed_ms = round((time.monotonic() - started) * 1000, 3)
    choices = response.get("choices", [])
    calls = choices[0].get("message", {}).get("tool_calls", []) if choices else []
    valid = False
    if calls and calls[0].get("function", {}).get("name") == "report_probe":
        arguments = calls[0]["function"].get("arguments", "{}")
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        valid = arguments == {"status": "local-ok"}
    return {
        "schema_version": 1,
        "kind": "local_tool_call_probe",
        "captured_at": utc_now(),
        "endpoint": base_url,
        "model": model,
        "elapsed_ms": elapsed_ms,
        "tool_call_valid": valid,
        "response_id": response.get("id"),
    }


def write_report(report: dict[str, Any], output: Path | None) -> None:
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if output is None:
        sys.stdout.write(serialized)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(serialized, encoding="utf-8")
    print(output)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inspect_parser = subparsers.add_parser("inspect", help="inventory host and checkpoint")
    inspect_parser.add_argument("--checkpoint", type=Path, required=True)
    inspect_parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    inspect_parser.add_argument("--output", type=Path)

    probe_parser = subparsers.add_parser("probe", help="probe a loopback OpenAI-compatible API")
    probe_parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    probe_parser.add_argument("--model", required=True)
    probe_parser.add_argument("--timeout", type=float, default=120.0)
    probe_parser.add_argument("--output", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        if args.command == "inspect":
            report = inspect_host(args.checkpoint, args.model_id)
        else:
            report = probe_endpoint(args.base_url, args.model, args.timeout)
        write_report(report, args.output)
        if args.command == "probe" and not report["tool_call_valid"]:
            return 2
        return 0
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
        print(f"preflight failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
