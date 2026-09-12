# GB10 model and runtime preflight

This experiment implements the reproducible evidence collection for task 9A. It
does not claim that Qwen3.8 Flash-Next fits or runs on a GB10 until the commands
below are executed on the assigned machine with the exact checkpoint and server.
It uses only the Python standard library and does not download a model.

## Verify the harness

```sh
cd experiments/gb10-preflight
python3 -m unittest -v
```

## Inventory the target and checkpoint

Run this on the GB10 after the checkpoint is present on local storage:

```sh
python3 gb10_preflight.py inspect \
  --checkpoint /absolute/path/to/Qwen3.8-Flash-Next \
  --output evidence/host-before-load.json
```

The report records CPU architecture, physical and available memory, storage,
GPU/driver data from `nvidia-smi`, relevant installed software, exact checkpoint
file totals, a deterministic path/size manifest digest, and the provisional
16/90/10/12 GB memory-envelope checks from the approved architecture. Checkpoint
disk size is explicitly treated as a lower bound rather than measured runtime
residency.

Start the selected local serving runtime with hosted fallback disabled and a
single active generation. Capture its configuration and launch command beside
the report. While it is loaded, run `inspect` again as
`evidence/host-loaded.json`. Run it a third time during the longest probe context
as `evidence/host-peak.json`; `nvidia-smi` alone may not represent all unified
memory, so retain the runtime's own metrics too.

## Verify local structured tool calling

The probe refuses endpoints that resolve outside loopback. It sends one bounded,
forced function call through an OpenAI-compatible local endpoint and returns a
nonzero status if the response does not contain the exact expected arguments.

```sh
python3 gb10_preflight.py probe \
  --base-url http://127.0.0.1:8000 \
  --model Qwen/Qwen3.8-Flash-Next \
  --output evidence/tool-call-first-run.json
```

Stop and restart the model server, repeat the host inventory and probe, and save
the second result as `evidence/tool-call-after-restart.json`. Then route the same
bounded tool through OpenClaw and retain its trace. Disconnect external networking
or apply the target's egress control and repeat the OpenClaw run; a loopback model
probe by itself does not prove that OpenClaw has no hosted fallback.

Task 9A can close only after the evidence includes the exact checkpoint and
runtime versions, successful load/restart, idle and peak memory, a real OpenClaw
tool call, and offline/no-fallback verification. If any check fails, preserve the
report and exact command rather than substituting a smaller or mocked model pass.
