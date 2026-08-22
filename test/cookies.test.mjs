/**
 * Cookie import tests.
 *
 * The importer's job is to accept whatever the operator actually has to hand,
 * so the cases here are real exporter output shapes rather than a single
 * canonical format.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCookieText,
  liveCookies,
  cookieDomains,
  CookieParseError,
} from "../dist/profiles/cookies.js";

test("reads a Playwright storageState file", () => {
  const parsed = parseCookieText(
    JSON.stringify({
      cookies: [
        {
          name: "cart",
          value: "abc123",
          domain: ".shop.example",
          path: "/",
          expires: 1893456000,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
  );

  assert.equal(parsed.format, "storage-state");
  assert.equal(parsed.cookies.length, 1);
  assert.deepEqual(parsed.cookies[0], {
    name: "cart",
    value: "abc123",
    domain: ".shop.example",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
});

test("reads an EditThisCookie array, including its own field spellings", () => {
  const parsed = parseCookieText(
    JSON.stringify([
      {
        name: "session",
        value: "xyz",
        domain: ".shop.example",
        path: "/",
        // EditThisCookie writes expirationDate as float seconds …
        expirationDate: 1893456000.123,
        // … "no_restriction" instead of "None" …
        sameSite: "no_restriction",
        hostOnly: false,
        secure: true,
      },
      {
        name: "hostonly",
        value: "1",
        // … and a leading dot even on host-only cookies.
        domain: ".shop.example",
        hostOnly: true,
      },
    ]),
  );

  assert.equal(parsed.format, "json-array");
  assert.equal(parsed.cookies[0].expires, 1893456000);
  assert.equal(parsed.cookies[0].sameSite, "None");
  // hostOnly strips the leading dot so the browser scopes it correctly.
  assert.equal(parsed.cookies[1].domain, "shop.example");
});

test("converts millisecond expiries to seconds", () => {
  const parsed = parseCookieText(
    JSON.stringify([{ name: "a", value: "b", domain: "x.example", expires: 1893456000000 }]),
  );
  assert.equal(parsed.cookies[0].expires, 1893456000);
});

test("treats a missing expiry as a session cookie", () => {
  const parsed = parseCookieText(JSON.stringify([{ name: "a", value: "b", domain: "x.example" }]));
  assert.equal(parsed.cookies[0].expires, -1);
});

test("reads a Netscape cookies.txt, honouring the #HttpOnly_ prefix", () => {
  const text = [
    "# Netscape HTTP Cookie File",
    "# This is a comment",
    ".shop.example\tTRUE\t/\tTRUE\t1893456000\tcart\tabc123",
    "#HttpOnly_.shop.example\tTRUE\t/\tTRUE\t1893456000\t_secure\tdeadbeef",
    "shop.example\tFALSE\t/\tFALSE\t0\tplain\tvalue",
  ].join("\n");

  const parsed = parseCookieText(text);
  assert.equal(parsed.format, "netscape");
  assert.equal(parsed.cookies.length, 3);

  assert.equal(parsed.cookies[0].name, "cart");
  assert.equal(parsed.cookies[0].secure, true);
  assert.equal(parsed.cookies[0].httpOnly, false);

  // The comment marker is a flag, not a comment.
  assert.equal(parsed.cookies[1].name, "_secure");
  assert.equal(parsed.cookies[1].httpOnly, true);

  // includeSubdomains FALSE must not gain a leading dot.
  assert.equal(parsed.cookies[2].domain, "shop.example");
  assert.equal(parsed.cookies[2].expires, -1);
});

test("detects the format from content, not the file extension", () => {
  // A Netscape file saved as .json, which is what happens in practice.
  const parsed = parseCookieText(".shop.example\tTRUE\t/\tTRUE\t1893456000\tcart\tabc");
  assert.equal(parsed.format, "netscape");
});

test("keeps an empty cookie value but rejects a missing one", () => {
  const parsed = parseCookieText(
    JSON.stringify([
      { name: "empty", value: "", domain: "x.example" },
      { name: "absent", domain: "x.example" },
    ]),
  );
  assert.equal(parsed.cookies.length, 1);
  assert.equal(parsed.cookies[0].name, "empty");
  assert.match(parsed.warnings[0], /absent/);
});

test("fails loudly rather than returning an empty jar", () => {
  // A silently empty cookie jar is indistinguishable from a logged-out
  // session at run time, which is the bug this behaviour prevents.
  assert.throws(() => parseCookieText(""), CookieParseError);
  assert.throws(() => parseCookieText("[]"), CookieParseError);
  assert.throws(() => parseCookieText("{ not json"), CookieParseError);
  assert.throws(() => parseCookieText(JSON.stringify({ nope: 1 })), CookieParseError);
});

test("drops cookies that have already expired", () => {
  const now = Date.UTC(2026, 0, 1);
  const cookies = [
    { name: "dead", value: "1", domain: "x", path: "/", expires: 1000, httpOnly: false, secure: false, sameSite: "Lax" },
    { name: "session", value: "1", domain: "x", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
    { name: "alive", value: "1", domain: "x", path: "/", expires: 4102444800, httpOnly: false, secure: false, sameSite: "Lax" },
  ];
  const live = liveCookies(cookies, now);
  assert.deepEqual(live.map((c) => c.name), ["session", "alive"]);
});

test("summarises domains most-frequent first", () => {
  const make = (domain) => ({ name: "n", value: "v", domain, path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" });
  const domains = cookieDomains([make(".a.example"), make("b.example"), make("a.example")]);
  assert.deepEqual(domains, ["a.example", "b.example"]);
});
