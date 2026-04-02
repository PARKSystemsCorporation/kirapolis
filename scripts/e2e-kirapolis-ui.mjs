import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const outDir = path.join(root, "tmp", "e2e-ui");
fs.mkdirSync(outDir, { recursive: true });

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.USERPROFILE || "", ".agent-browser", "browsers", "chrome-147.0.7727.24", "chrome-win64", "chrome.exe"),
].filter(Boolean);

function resolveChrome() {
  const match = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error("Chrome executable not found for headless UI verification");
  }
  return match;
}

const chromeBin = resolveChrome();

function runChrome(args) {
  return execFileSync(chromeBin, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertIncludes(text, needle, label) {
  if (!String(text).includes(needle)) {
    throw new Error(`${label} missing "${needle}"`);
  }
}

function assertIncludesAny(text, needles, label) {
  if (!needles.some((needle) => String(text).includes(needle))) {
    throw new Error(`${label} missing one of: ${needles.join(", ")}`);
  }
}

async function ensureHealth() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:4317/health");
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Agent server health check failed");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.json();
}

async function verifyOfficeTapFlow() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  try {
    await page.goto("http://127.0.0.1:4317/app?tab=office&fullscreen=1", { waitUntil: "domcontentloaded" });
    const frame = page.frameLocator("#office-scene-frame");
    await frame.locator(".agent-node").first().waitFor({ state: "visible", timeout: 30000 });
    const hiddenBefore = await frame.locator("#office-drawer").evaluate((node) => node.classList.contains("hidden"));
    if (!hiddenBefore) {
      throw new Error("Office drawer should start hidden in fullscreen monitor mode");
    }
    await frame.locator(".agent-node").first().evaluate((node) => node.click());
    await page.waitForTimeout(300);
    const hiddenAfter = await frame.locator("#office-drawer").evaluate((node) => node.classList.contains("hidden"));
    if (hiddenAfter) {
      throw new Error("Office drawer did not open after tapping an agent");
    }
    const title = await frame.locator("#office-drawer-title").innerText();
    assertIncludes(title, "Agent Card", "Office tap drawer title");
  } finally {
    await browser.close();
  }
}

function render(url, screenshotName) {
  const screenshotPath = path.join(outDir, screenshotName);
  runChrome([
    "--headless=new",
    "--disable-gpu",
    "--window-size=1440,1100",
    "--virtual-time-budget=9000",
    `--screenshot=${screenshotPath}`,
    url,
  ]);
  const dom = runChrome([
    "--headless=new",
    "--disable-gpu",
    "--virtual-time-budget=9000",
    "--dump-dom",
    url,
  ]);
  return { screenshotPath, dom };
}

async function main() {
  await ensureHealth();

  const office = render("http://127.0.0.1:4317/experience/office/", "office.png");
  assertIncludes(office.dom, "Fullscreen operations floor with playable management controls", "Office hero");
  assertIncludes(office.dom, "Agent Card", "Office drawer");
  assertIncludes(office.dom, "Workspace Gate", "Office utility hotspot");
  assertIncludesAny(office.dom, ["Director Mode", "Retro Floor", "Closed Loop Monitor"], "Office director banner");

  const officeBackground = render("http://127.0.0.1:4317/experience/office/?embed=1&background=1", "office-background.png");
  assertIncludes(officeBackground.dom, "office-map", "Office fullscreen background");

  const appOps = render("http://127.0.0.1:4317/app?tab=watch", "app-ops.png");
  assertIncludes(appOps.dom, "Game Director", "Ops director panel");
  assertIncludes(appOps.dom, "Director Scenarios", "Ops scenario panel");
  const signals = await getJson("http://127.0.0.1:4317/api/experience/signals");
  const directorScenarioText = JSON.stringify(signals?.directorMode?.scenarios || []);
  const questBoardText = JSON.stringify(signals?.questBoard || []);
  assertIncludesAny(questBoardText, ["Stabilize Post Deploy", "Advance Persistent State", "Push Backend Builder to the next level"], "Ops active scenario");
  assertIncludesAny(directorScenarioText, ["Milestone Push: Persistent State", "Milestone Push: Browser Foundation"], "Ops milestone scenario");

  const appLab = render("http://127.0.0.1:4317/app?tab=lab", "app-lab.png");
  assertIncludes(appLab.dom, "Abliteration Machine", "Model lab hero");
  assertIncludes(appLab.dom, "Behavior Check", "Model lab chat");
  assertIncludes(appLab.dom, "Data Reintroduction", "Model lab reintroduction section");
  assertIncludes(appLab.dom, "Workflow Timeline", "Model lab timeline section");
  assertIncludes(appLab.dom, "Neutralization Summary", "Model lab summary strip");
  assertIncludes(appLab.dom, "Weight Unlearning", "Model lab weight unlearning panel");
  assertIncludes(appLab.dom, "Build Dataset", "Model lab weight unlearning actions");

  const fullscreenOffice = render("http://127.0.0.1:4317/app?tab=office&fullscreen=1", "app-office-fullscreen.png");
  assertIncludes(fullscreenOffice.dom, "Settings", "Fullscreen office top nav");
  assertIncludes(fullscreenOffice.dom, "Live Loop", "Fullscreen office compact panel");
  await verifyOfficeTapFlow();

  const fullscreenChat = render("http://127.0.0.1:4317/app?tab=chat&fullscreen=1", "app-chat-fullscreen.png");
  assertIncludes(fullscreenChat.dom, "Closed Loop", "Fullscreen chat room");
  assertIncludes(fullscreenChat.dom, "Room Transcript", "Fullscreen chat transcript");
  assertIncludes(fullscreenChat.dom, "Room Context", "Fullscreen chat side context");

  const appWorkspace = render("http://127.0.0.1:4317/app?tab=files&agentId=agent-ceo", "app-workspace.png");
  assertIncludes(appWorkspace.dom, "Review the live site beside the exact files and notes your agents are producing", "Workspace hero");
  assertIncludes(appWorkspace.dom, "Reload Site", "Workspace quick relay");
  assertIncludesAny(appWorkspace.dom, ["CEO", "Project Manager", "Global workspace"], "Workspace agent focus");

  console.log(`Kirapolis UI E2E passed. Artifacts: ${outDir}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
