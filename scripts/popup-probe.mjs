/** Probe popups / buy-box blockers on the 3 card sites. */
import { chromium } from "playwright-core";
import { join } from "node:path";
import { existsSync } from "node:fs";
const exe = join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
const ctx = await chromium.launchPersistentContext("./profiles-pop", { headless: true, executablePath: exe,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  args: ["--no-first-run","--disable-blink-features=AutomationControlled","--disable-dev-shm-usage"] });
const page = ctx.pages()[0] ?? await ctx.newPage();
for (const site of ["https://www.goldenrodcity.com/","https://common-lands.com/","https://zardocards.com/"]) {
  console.log(`\n############ ${site} ############`);
  try { await page.goto(site, { waitUntil: "domcontentloaded", timeout: 45000 }); await page.waitForTimeout(6000); }
  catch (e) { console.log("nav err:", String(e).split("\n")[0]); }
  // What overlays/blocks are present?
  const info = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div, section, aside')).filter((e) => {
      const rect = e.getBoundingClientRect(), st = getComputedStyle(e);
      return st.position === "fixed" && rect.width > 300 && rect.height > 250 && st.display !== "none" && e.offsetParent;
    }).slice(0,5).map(e => ({ cls: (e.className||"").toString().slice(0,60), id: e.id||"", zidx: getComputedStyle(e).zIndex, hasBtn: !!e.querySelector("button, a") }));
    const buttons = Array.from(document.querySelectorAll("button, a")).filter(b => {
      const t = ((b.textContent||"")+" "+(b.getAttribute("aria-label")||"")).trim();
      return /enter|continue|confirm|ok|accept|agree|got it|dismiss|close|18\+|adult|proceed|i am|shop now|start/i.test(t);
    }).slice(0,8).map(b => ({ txt:(b.textContent||"").trim().slice(0,30), aria:b.getAttribute("aria-label")||"", cls:(b.className||"").toString().slice(0,30) }));
    return { title: document.title, overlays, buttons };
  }).catch(e=>"ERR "+e);
  console.log(JSON.stringify(info, null, 1));
}
await ctx.close().catch(()=>{});
try { await import("node:fs").then(m=>m.rmSync("./profiles-pop",{recursive:true,force:true})); } catch {}
process.exit(0);
