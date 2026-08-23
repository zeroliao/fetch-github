import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfiguredProxyURL } from "../src/server/outboundFetch";

test("configured outbound proxy prefers the direct fetchGithub URL", () => {
  const previous = {
    direct: process.env.FETCHGITHUB_PROXY_URL,
    envName: process.env.FETCHGITHUB_PROXY_URL_ENV,
    sub2api: process.env.SUB2API_PROXY_URL,
    github: process.env.GITHUB_PROXY_URL
  };
  try {
    process.env.FETCHGITHUB_PROXY_URL = "socks5://127.0.0.1:31000";
    process.env.FETCHGITHUB_PROXY_URL_ENV = "SUB2API_PROXY_URL";
    process.env.SUB2API_PROXY_URL = "socks5://127.0.0.1:31001";
    assert.equal(resolveConfiguredProxyURL(), "socks5://127.0.0.1:31000");
  } finally {
    restore("FETCHGITHUB_PROXY_URL", previous.direct);
    restore("FETCHGITHUB_PROXY_URL_ENV", previous.envName);
    restore("SUB2API_PROXY_URL", previous.sub2api);
    restore("GITHUB_PROXY_URL", previous.github);
  }
});

test("configured outbound proxy resolves an indirection environment variable", () => {
  const previous = {
    direct: process.env.FETCHGITHUB_PROXY_URL,
    envName: process.env.FETCHGITHUB_PROXY_URL_ENV,
    target: process.env.SUB2API_PROXY_URL
  };
  try {
    delete process.env.FETCHGITHUB_PROXY_URL;
    process.env.FETCHGITHUB_PROXY_URL_ENV = "SUB2API_PROXY_URL";
    process.env.SUB2API_PROXY_URL = "socks5://127.0.0.1:31002";
    assert.equal(resolveConfiguredProxyURL(), "socks5://127.0.0.1:31002");
  } finally {
    restore("FETCHGITHUB_PROXY_URL", previous.direct);
    restore("FETCHGITHUB_PROXY_URL_ENV", previous.envName);
    restore("SUB2API_PROXY_URL", previous.target);
  }
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
