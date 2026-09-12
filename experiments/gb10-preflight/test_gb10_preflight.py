import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import gb10_preflight


class PreflightTests(unittest.TestCase):
    def test_budget_accepts_exact_documented_boundary(self):
        report = gb10_preflight.MemoryBudget(
            total_bytes=128 * gb10_preflight.DECIMAL_GB,
            available_bytes=128 * gb10_preflight.DECIMAL_GB,
            checkpoint_bytes=90 * gb10_preflight.DECIMAL_GB,
        ).evaluate()
        self.assertTrue(report["passes_static_envelope"])
        self.assertEqual(report["projected_headroom_bytes"], 12 * gb10_preflight.DECIMAL_GB)
        self.assertTrue(report["checks"]["checkpoint_within_weight_envelope"])

    def test_budget_rejects_checkpoint_above_weight_envelope(self):
        report = gb10_preflight.MemoryBudget(
            total_bytes=128 * gb10_preflight.DECIMAL_GB,
            available_bytes=128 * gb10_preflight.DECIMAL_GB,
            checkpoint_bytes=91 * gb10_preflight.DECIMAL_GB,
        ).evaluate()
        self.assertFalse(report["passes_static_envelope"])
        self.assertFalse(report["checks"]["checkpoint_within_weight_envelope"])

    def test_artifact_manifest_is_deterministic_and_excludes_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.safetensors").write_bytes(b"weights")
            (root / "config.json").write_text("{}", encoding="utf-8")
            (root / "link.bin").symlink_to(root / "model.safetensors")
            first = gb10_preflight.artifact_inventory(root)
            second = gb10_preflight.artifact_inventory(root)
        self.assertEqual(first["manifest_sha256"], second["manifest_sha256"])
        self.assertEqual(first["file_count"], 2)
        self.assertEqual(first["weight_file_count"], 1)

    def test_probe_accepts_valid_loopback_tool_call(self):
        response = {
            "id": "local-test",
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "function": {
                                    "name": "report_probe",
                                    "arguments": json.dumps({"status": "local-ok"}),
                                }
                            }
                        ]
                    }
                }
            ],
        }
        with patch.object(gb10_preflight, "post_json", return_value=response) as post:
            report = gb10_preflight.probe_endpoint(
                "http://127.0.0.1:8000", "local-model", 2
            )
        payload = post.call_args.args[1]
        self.assertEqual(payload["tool_choice"]["function"]["name"], "report_probe")
        self.assertTrue(report["tool_call_valid"])
        self.assertEqual(report["response_id"], "local-test")

    def test_probe_rejects_non_loopback_endpoint(self):
        with self.assertRaisesRegex(ValueError, "loopback"):
            gb10_preflight.require_loopback("https://192.0.2.10:8000")


if __name__ == "__main__":
    unittest.main()
