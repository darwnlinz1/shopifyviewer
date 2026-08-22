/**
 * Proxy parsing tests.
 *
 * The formats here are the ones operators actually paste: full URLs from
 * documentation, and the bare colon-separated form proxy vendors hand out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProxy, validateProxy, redactProxy, ProxyParseError } from "../dist/profiles/proxy.js";

test("parses a full URL with credentials", () => {
  const proxy = parseProxy("http://user:pa55@gate.example:8080");
  assert.equal(proxy.server, "http://gate.example:8080");
  assert.equal(proxy.protocol, "http");
  assert.equal(proxy.username, "user");
  assert.equal(proxy.password, "pa55");
});

test("keeps credentials out of `server`, which is what Playwright needs", () => {
  // Playwright rejects inline credentials in `server` and needs them split
  // into username/password, which is the whole reason this parse exists.
  const proxy = parseProxy("http://user:pass@gate.example:8080");
  assert.ok(!proxy.server.includes("user"));
  assert.ok(!proxy.server.includes("pass"));
});

test("decodes percent-encoded credentials", () => {
  // A password containing @ or : has to be encoded in a URL, and has to be
  // decoded again before it is sent to the proxy.
  const proxy = parseProxy("http://user%40corp:p%3Ass%40word@gate.example:8080");
  assert.equal(proxy.username, "user@corp");
  assert.equal(proxy.password, "p:ss@word");
});

test("parses the vendor host:port:user:pass form", () => {
  const proxy = parseProxy("gate.example:8080:user:pass");
  assert.equal(proxy.server, "http://gate.example:8080");
  assert.equal(proxy.username, "user");
  assert.equal(proxy.password, "pass");
});

test("parses a bare host:port", () => {
  const proxy = parseProxy("gate.example:3128");
  assert.equal(proxy.server, "http://gate.example:3128");
  assert.equal(proxy.username, undefined);
});

test("supports socks schemes and their default port", () => {
  assert.equal(parseProxy("socks5://gate.example:1080").protocol, "socks5");
  assert.equal(parseProxy("socks5://gate.example").port, 1080);
});

test("assumes http when credentials are given without a scheme", () => {
  const proxy = parseProxy("user:pass@gate.example:8080");
  assert.equal(proxy.protocol, "http");
  assert.equal(proxy.server, "http://gate.example:8080");
  assert.equal(proxy.username, "user");
});

test("rejects nonsense rather than guessing", () => {
  assert.throws(() => parseProxy(""), ProxyParseError);
  assert.throws(() => parseProxy("   "), ProxyParseError);
  assert.throws(() => parseProxy("ftp://gate.example:21"), /unsupported proxy scheme/);
  assert.throws(() => parseProxy("http://gate.example:0"), /invalid proxy port/);
  // Out-of-range ports are rejected by the URL parser before we see them, so
  // the message differs; what matters is that nothing invalid gets through.
  assert.throws(() => parseProxy("http://gate.example:99999"), ProxyParseError);
  assert.throws(() => parseProxy("!!!"), ProxyParseError);
  assert.throws(() => parseProxy("http://not a host:8080"), ProxyParseError);
});

test("validateProxy reports instead of throwing", () => {
  assert.equal(validateProxy("http://gate.example:8080").ok, true);
  const bad = validateProxy("ftp://x:21");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unsupported/);
});

test("redaction never leaks a password", () => {
  const redacted = redactProxy("http://user:hunter2@gate.example:8080");
  assert.ok(!redacted.includes("hunter2"));
  assert.ok(!redacted.includes("user"));
  assert.ok(redacted.includes("gate.example:8080"));
  // Unparseable input must not be echoed back into a log line either.
  assert.equal(redactProxy("!!!"), "<proxy>");
});
