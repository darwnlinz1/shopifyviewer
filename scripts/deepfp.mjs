/** Deep-fingerprint: what does a Shopify page actually see on our stack? Mirror the project's launch (UA override + stealth) and dump every tell. */
import { chromium } from "playwright-core";
import { join } from "node:path";
const exe = join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const ctx = await chromium.launchPersistentContext("./profiles-df", { headless: true, executablePath: exe, userAgent: ua,
  args: ["--no-first-run","--disable-blink-features=AutomationControlled","--disable-dev-shm-usage","--disable-extensions"] });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto("about:blank").catch(()=>{});
const tells = await page.evaluate(() => {
  const out = {};
  out.webdriver = navigator.webdriver;
  out.ua = navigator.userAgent;
  out.uaCH = (navigator.userAgentData) ? navigator.userAgentData.brands.map(b=>b.brand+" "+b.version).join(", ") : "no-UA-CH";
  out.uaCH_mobile = navigator.userAgentData ? navigator.userAgentData.mobile : null;
  out.headlessMarker = /HeadlessChrome|Headless/i.test(navigator.userAgent);
  out.plugins = navigator.plugins.length;
  out.mimeTypes = navigator.mimeTypes.length;
  out.webglVendor = (()=>{try{const gl=document.createElement('canvas').getContext('webgl');return gl?gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_VENDOR_WEBGL:37445):'no-gl';}catch(e){return 'err';}})();
  out.webglRenderer = (()=>{try{const gl=document.createElement('canvas').getContext('webgl');const info=gl.getExtension('WEBGL_debug_renderer_info');return gl?gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:37446):'no-gl';}catch(e){return 'err';}})();
  out.deviceMemory = navigator.deviceMemory ?? null;
  out.hardwareConcurrency = navigator.hardwareConcurrency;
  out.platform = navigator.platform;
  out.maxTouchPoints = navigator.maxTouchPoints;
  out.fonts = (()=>{try{return document.fonts ? document.fonts.size : 'n/a';}catch(e){return 'err';}})();
  out.canvasFp = (()=>{try{const c=document.createElement('canvas');c.width=220;c.height=30;const g=c.getContext('2d');g.font='18px Arial';g.fillText('fp-test',5,20);return c.toDataURL().slice(0,50);}catch(e){return 'err';}})();
  out.audioFp = (()=>{try{const ac=new (window.AudioContext||window.webkitAudioContext)();const o=ac.createOscillator();const analyser=ac.createAnalyser();const data=new Uint8Array(analyser.frequencyBinCount);o.connect(analyser);analyser.getByteFrequencyData(data);o.disconnect();return data.length+' bins';}catch(e){return 'no-audio';}})();
  out.permissions = (()=>{try{return typeof navigator.permissions.query;}catch(e){return 'err';}})();
  out.windowChrome = typeof window.chrome;
  out.languages = navigator.languages.join(',');
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.doNotTrack = navigator.doNotTrack;
  return out;
}).catch(e=>"ERR "+e);
console.log("=== fingerprint ==="); console.log(JSON.stringify(tells,null,1));

// Check the API leak via a real CDP client eventually; for now go to a shopify home and see if CF/US wall fires
await page.goto("https://www.goldenrodcity.com/", { waitUntil:"domcontentloaded", timeout:45000 }).catch(()=>{});
await page.waitForTimeout(5000);
const final = { url: page.url(), title: await page.title().catch(()=>""), hasChallenge: /just a moment|checking your browser|cf_chl|error 1020|access denied/i.test(await page.content().catch(()=>"").then(c=>c.slice(0,2000))) };
console.log("\n=== shopify response ==="); console.log(JSON.stringify(final,null,1));
await ctx.close().catch(()=>{});
try { await import("node:fs").then(m=>m.rmSync("./profiles-df",{recursive:true,force:true})); } catch {}
process.exit(0);
