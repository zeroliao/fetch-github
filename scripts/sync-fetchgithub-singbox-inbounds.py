#!/usr/bin/env python3
"""Export only Sing-box inbound metadata for the fetchGithub web service."""

import argparse
import grp
import json
import os
import tempfile


SUPPORTED_TYPES = {"http", "socks", "mixed"}


def export_inbounds(source: str, target: str) -> None:
    with open(source, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    inbounds = []
    for inbound in config.get("inbounds", []) if isinstance(config, dict) else []:
        if not isinstance(inbound, dict) or inbound.get("type") not in SUPPORTED_TYPES:
            continue
        try:
            port = int(inbound["listen_port"])
        except (KeyError, TypeError, ValueError):
            continue
        if not 1 <= port <= 65535:
            continue
        item = {
            "type": inbound["type"],
            "tag": str(inbound.get("tag") or f"{inbound['type']}-{port}"),
            "listen": str(inbound.get("listen") or "127.0.0.1"),
            "listen_port": port,
        }
        if item not in inbounds:
            inbounds.append(item)

    directory = os.path.dirname(target) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".fetchgithub-inbounds.", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"inbounds": inbounds}, handle, ensure_ascii=True, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o640)
        os.chown(temporary, 0, grp.getgrnam("ubuntu").gr_gid)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()
    export_inbounds(args.source, args.target)


if __name__ == "__main__":
    main()
