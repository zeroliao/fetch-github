import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listSingboxProxyNodes,
  parseSingboxProxyNodes,
} from "../src/server/singbox";

test("parses HTTP, SOCKS, and mixed inbounds with defaults", () => {
  const nodes = parseSingboxProxyNodes(`{
    // JSONC comments and trailing commas are accepted.
    "inbounds": [
      { "type": "http", "tag": "http-out", "listen_port": 31001, },
      { "type": "socks", "tag": "socks-out", "listen": "127.0.0.1", "listen_port": 31002 },
      { "type": "mixed", "tag": "mixed-out", "listen": "::1", "listen_port": 31003 }
    ]
  }`);

  assert.deepEqual(
    nodes.map(({ name, address, protocol, host, port }) => ({
      name,
      address,
      protocol,
      host,
      port,
    })),
    [
      {
        name: "http-out",
        address: "http://127.0.0.1:31001",
        protocol: "http",
        host: "127.0.0.1",
        port: 31001,
      },
      {
        name: "socks-out",
        address: "socks5://127.0.0.1:31002",
        protocol: "socks5",
        host: "127.0.0.1",
        port: 31002,
      },
      {
        name: "mixed-out",
        address: "socks5://[::1]:31003",
        protocol: "socks5",
        host: "[::1]",
        port: 31003,
      },
    ],
  );
});

test("normalizes wildcard listen addresses to the local endpoint", () => {
  const nodes = parseSingboxProxyNodes(
    JSON.stringify({
      inbounds: [
        { type: "socks", listen: "0.0.0.0", listen_port: 31000 },
        { type: "http", listen: "::", listen_port: 31001 },
        { type: "mixed", listen: "*", listen_port: 31002 },
      ],
    }),
  );

  assert.deepEqual(
    nodes.map(({ address, host }) => ({ address, host })),
    [
      { address: "socks5://127.0.0.1:31000", host: "127.0.0.1" },
      { address: "http://127.0.0.1:31001", host: "127.0.0.1" },
      { address: "socks5://127.0.0.1:31002", host: "127.0.0.1" },
    ],
  );
});

test("skips invalid ports and unsupported inbound types and de-duplicates nodes", () => {
  const nodes = parseSingboxProxyNodes(
    JSON.stringify({
      inbounds: [
        { type: "http", listen_port: 0 },
        { type: "socks", listen_port: 65536 },
        { type: "tun", listen_port: 31001 },
        { type: "http", tag: "first", listen_port: 31011 },
        { type: "http", tag: "duplicate", listen_port: 31011 },
      ],
    }),
  );

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "duplicate");
  assert.equal(nodes[0].address, "http://127.0.0.1:31011");
});

test("returns no nodes for malformed configuration", () => {
  assert.deepEqual(parseSingboxProxyNodes("{ invalid"), []);
  assert.deepEqual(
    parseSingboxProxyNodes(JSON.stringify({ inbounds: "invalid" })),
    [],
  );
});

test("discovers nodes from the configured Sing-box path", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "fetchgithub-singbox-"),
  );
  const file = path.join(directory, "config.json");
  const previous = process.env.SINGBOX_CONFIG_PATH;
  try {
    await writeFile(
      file,
      JSON.stringify({ inbounds: [{ type: "http", listen_port: 31111 }] }),
      "utf8",
    );
    process.env.SINGBOX_CONFIG_PATH = file;
    const nodes = await listSingboxProxyNodes();
    assert.ok(nodes.some((node) => node.address === "http://127.0.0.1:31111"));
  } finally {
    if (previous === undefined) delete process.env.SINGBOX_CONFIG_PATH;
    else process.env.SINGBOX_CONFIG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
