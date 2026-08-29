import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfiguredProxyURL } from "../src/server/outboundFetch";

test("configured outbound proxy prefers the direct fetchGithub URL", () => {
  const previous = {
    envName: process.env.GITHUB_PROXY_URL_ENV,
    sub2api: process.env.SUB2API_PROXY_URL,
    github: process.env.GITHUB_PROXY_URL,
  };
  try {
    process.env.GITHUB_PROXY_URL_ENV = "SUB2API_PROXY_URL";
    process.env.SUB2API_PROXY_URL = "socks5://127.0.0.1:31001";
    assert.equal(resolveConfiguredProxyURL(), "socks5://127.0.0.1:31001");
  } finally {
    restore("GITHUB_PROXY_URL_ENV", previous.envName);
    restore("SUB2API_PROXY_URL", previous.sub2api);
    restore("GITHUB_PROXY_URL", previous.github);
  }
});

test("configured outbound proxy resolves an indirection environment variable", () => {
  const previous = {
    envName: process.env.GITHUB_PROXY_URL_ENV,
    target: process.env.SUB2API_PROXY_URL,
  };
  try {
    process.env.GITHUB_PROXY_URL_ENV = "SUB2API_PROXY_URL";
    process.env.SUB2API_PROXY_URL = "socks5://127.0.0.1:31002";
    assert.equal(resolveConfiguredProxyURL(), "socks5://127.0.0.1:31002");
  } finally {
    restore("GITHUB_PROXY_URL_ENV", previous.envName);
    restore("SUB2API_PROXY_URL", previous.target);
  }
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
