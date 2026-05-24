#!/usr/bin/env python3
"""BLAST Link handshake for MultiWA.

This script intentionally prints no secret values. Detailed output is written to
.tmp/link_check.json with secrets redacted or omitted.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = PROJECT_ROOT / ".tmp"
REPORT_PATH = TMP_DIR / "link_check.json"

CRITICAL_CHECKS = {
    "env_required",
    "postgres_tcp",
    "redis_tcp",
    "prisma_schema",
    "postgres_auth",
    "redis_ping",
    "api_docs",
}


def parse_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue

        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()

        env[key] = value

    return env


def result(name: str, status: str, details: str = "") -> dict[str, str]:
    return {"name": name, "status": status, "details": details}


def run_command(
    name: str,
    args: list[str],
    env: dict[str, str],
    stdin: str | None = None,
    timeout: int = 20,
) -> dict[str, str]:
    try:
        completed = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            env={**os.environ, **env},
            input=stdin,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return result(name, "skipped", f"{args[0]} not available")
    except subprocess.TimeoutExpired:
        return result(name, "failed", "command timed out")

    output = sanitize_output((completed.stdout or "") + (completed.stderr or ""))
    if completed.returncode == 0:
        details = first_nonempty_line(output) or "ok"
        return result(name, "passed", details)

    details = first_relevant_error(output) or f"exit code {completed.returncode}"
    return result(name, "failed", details)


def sanitize_output(output: str) -> str:
    output = re.sub(r"(postgres(?:ql)?://)[^\s]+", r"\1***", output)
    output = re.sub(r"(redis://)[^\s]+", r"\1***", output)
    output = re.sub(r"([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^\s]+", r"\1***", output)
    output = re.sub(r"([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+", r"\1***", output)
    output = re.sub(r"([A-Za-z0-9_]*KEY[A-Za-z0-9_]*=)[^\s]+", r"\1***", output)
    return output.strip()


def first_nonempty_line(output: str) -> str:
    for line in output.splitlines():
        line = line.strip()
        if line:
            return line[:240]
    return ""


def first_relevant_error(output: str) -> str:
    prisma_match = re.search(r"\bP\d{4}\b", output)
    if prisma_match:
        return f"Prisma error {prisma_match.group(0)}"

    preferred = ("Error:", "P1000", "P1001", "P1002", "failed", "Failed", "ECONNREFUSED")
    for line in output.splitlines():
        stripped = line.strip()
        if any(token in stripped for token in preferred):
            return stripped[:240]
    return first_nonempty_line(output)


def url_tcp_check(name: str, raw_url: str | None, default_port: int) -> dict[str, str]:
    if not raw_url:
        return result(name, "failed", "missing url")
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        return result(name, "failed", "invalid url")

    if not parsed.hostname:
        return result(name, "failed", "missing hostname")

    port = parsed.port or default_port
    try:
        with socket.create_connection((parsed.hostname, port), timeout=2):
            return result(name, "passed", f"tcp reachable on port {port}")
    except OSError:
        return result(name, "failed", f"tcp unreachable on port {port}")


def normalize_base_url(raw_url: str) -> str:
    return raw_url.rstrip("/")


def check_api_docs(env: dict[str, str]) -> dict[str, str]:
    base_url = env.get("MULTIWA_BASE_URL") or env.get("NEXT_PUBLIC_API_URL")
    if base_url:
        url = f"{normalize_base_url(base_url)}/api/docs"
    else:
        port = env.get("API_PORT") or "3333"
        url = f"http://localhost:{port}/api/docs"

    request = Request(url, method="HEAD")
    try:
        with urlopen(request, timeout=2) as response:
            return result("api_docs", "passed", f"HTTP {response.status} on configured API endpoint")
    except URLError:
        return result("api_docs", "failed", "API docs endpoint unreachable")
    except Exception as exc:  # noqa: BLE001 - report sanitized failure only
        return result("api_docs", "failed", type(exc).__name__)


def check_multiwa_containers() -> dict[str, str]:
    if not shutil.which("docker"):
        return result("docker_multiwa_containers", "skipped", "docker not available")
    completed = subprocess.run(
        ["docker", "ps", "--filter", "name=multiwa", "--format", "{{.Names}}"],
        cwd=PROJECT_ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    if completed.returncode != 0:
        return result("docker_multiwa_containers", "skipped", "docker ps unavailable")
    names = [line for line in completed.stdout.splitlines() if line.strip()]
    if not names:
        return result("docker_multiwa_containers", "failed", "no running MultiWA containers")
    return result("docker_multiwa_containers", "passed", f"{len(names)} running MultiWA container(s)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BLAST Link handshake for MultiWA")
    parser.add_argument(
        "--env-file",
        default=".env",
        help="Path to env file, relative to project root unless absolute",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env_path = Path(args.env_file)
    if not env_path.is_absolute():
        env_path = PROJECT_ROOT / env_path

    started_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    env = parse_env(env_path)
    example_env = parse_env(PROJECT_ROOT / ".env.example")

    checks: list[dict[str, str]] = []

    checks.append(
        result(
            "env_file",
            "passed" if env_path.exists() else "failed",
            str(env_path.relative_to(PROJECT_ROOT)) if env_path.exists() and env_path.is_relative_to(PROJECT_ROOT) else "missing env file",
        )
    )

    required = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET"]
    missing_required = [key for key in required if not env.get(key)]
    checks.append(
        result(
            "env_required",
            "failed" if missing_required else "passed",
            "missing: " + ", ".join(missing_required) if missing_required else "required keys present",
        )
    )

    missing_example = sorted(set(example_env) - set(env))
    checks.append(
        result(
            "env_example_parity",
            "warning" if missing_example else "passed",
            "missing optional/example keys: " + ", ".join(missing_example)
            if missing_example
            else "matches example keys",
        )
    )

    jwt_secret = env.get("JWT_SECRET", "")
    checks.append(
        result(
            "jwt_secret_length",
            "passed" if len(jwt_secret) >= 32 else "failed",
            f"length {len(jwt_secret)}",
        )
    )

    checks.append(url_tcp_check("postgres_tcp", env.get("DATABASE_URL"), 5432))
    checks.append(url_tcp_check("redis_tcp", env.get("REDIS_URL"), 6379))

    checks.append(
        run_command(
            "prisma_schema",
            ["pnpm", "--filter", "@multiwa/database", "exec", "prisma", "validate", "--schema", "prisma/schema.prisma"],
            env,
        )
    )

    checks.append(
        run_command(
            "postgres_auth",
            [
                "pnpm",
                "--filter",
                "@multiwa/database",
                "exec",
                "prisma",
                "db",
                "execute",
                "--schema",
                "prisma/schema.prisma",
                "--stdin",
            ],
            env,
            stdin="SELECT 1;",
        )
    )

    if shutil.which("redis-cli"):
        checks.append(run_command("redis_ping", ["redis-cli", "-u", env.get("REDIS_URL", ""), "ping"], env))
    else:
        checks.append(result("redis_ping", "skipped", "redis-cli not available"))

    checks.append(check_api_docs(env))
    checks.append(check_multiwa_containers())

    has_failed_critical = any(
        check["status"] == "failed" and check["name"] in CRITICAL_CHECKS for check in checks
    )
    overall = "failed" if has_failed_critical else "passed"

    report: dict[str, Any] = {
        "startedAt": started_at,
        "envFile": str(env_path.relative_to(PROJECT_ROOT)) if env_path.exists() and env_path.is_relative_to(PROJECT_ROOT) else args.env_file,
        "overall": overall,
        "checks": checks,
    }

    TMP_DIR.mkdir(exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"BLAST Link check: {overall}")
    for check in checks:
        print(f"- {check['name']}: {check['status']} - {check['details']}")
    print(f"Report: {REPORT_PATH.relative_to(PROJECT_ROOT)}")

    return 1 if has_failed_critical else 0


if __name__ == "__main__":
    raise SystemExit(main())
