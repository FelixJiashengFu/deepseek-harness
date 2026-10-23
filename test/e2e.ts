// End-to-end test: builds a small Deno library with stubbed modules and tests, then drives the
// harness MCP server like an orchestrator would: dispatch -> wait -> result -> integrate (with a
// deliberate conflict) -> land (with a concurrent edit in the main tree) -> cleanup.
// Usage: deno run -A --no-config test/e2e.ts <empty scratch dir>
// It spends a little DeepSeek credit (five short workers).

const base = Deno.args[0];
if (!base) throw new Error("usage: e2e.ts <scratch dir>");
const sep = Deno.build.os === "windows" ? "\\" : "/";
const repo = `${base}${sep}demo`;
const home = `${base}${sep}home`;
const server = new URL("../server/main.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function sh(cmd: string, args: string[], cwd = repo) {
  const r = new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).outputSync();
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${out}`);
  return out;
}

function write(rel: string, text: string) {
  const p = `${repo}/${rel}`;
  Deno.mkdirSync(p.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  Deno.writeTextFileSync(p, text);
}

// ---- demo repository ----
Deno.mkdirSync(repo, { recursive: true });
sh("git", ["init", "-q"]);
write("tests/assert.ts", `export function eq(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(\`\${msg} expected \${e}, got \${a}\`);
}
`);
write("src/stats.ts", `// Numeric helpers. Every function must work on any non-empty array.
export function mean(xs: number[]): number { throw new Error("TODO"); }
export function median(xs: number[]): number { throw new Error("TODO"); }
export function mode(xs: number[]): number { throw new Error("TODO: smallest of the most frequent values"); }
export function stdev(xs: number[]): number { throw new Error("TODO: population standard deviation"); }
export function percentile(xs: number[], p: number): number { throw new Error("TODO: linear interpolation, p in [0,100]"); }
`);
write("tests/stats_test.ts", `import { eq } from "./assert.ts";
import { mean, median, mode, percentile, stdev } from "../src/stats.ts";
Deno.test("mean", () => { eq(mean([1, 2, 3, 4]), 2.5); eq(mean([5]), 5); });
Deno.test("median", () => { eq(median([3, 1, 2]), 2); eq(median([4, 1, 3, 2]), 2.5); });
Deno.test("mode", () => { eq(mode([1, 2, 2, 3, 3]), 2); eq(mode([7]), 7); });
Deno.test("stdev", () => { eq(Math.round(stdev([2, 4, 4, 4, 5, 5, 7, 9]) * 1000) / 1000, 2); });
Deno.test("percentile", () => { eq(percentile([1, 2, 3, 4, 5], 50), 3); eq(percentile([1, 2, 3, 4], 25), 1.75); eq(percentile([10, 20], 100), 20); });
`);
write("src/text.ts", `// String helpers.
export function slugify(s: string): string { throw new Error("TODO: lowercase, ASCII letters/digits, single dashes, no leading/trailing dash"); }
export function wordCount(s: string): number { throw new Error("TODO"); }
export function titleCase(s: string): string { throw new Error("TODO: capitalise each word, lowercase the rest"); }
export function truncate(s: string, n: number): string { throw new Error("TODO: at most n chars; if cut, end with an ellipsis character within n"); }
export function isPalindrome(s: string): boolean { throw new Error("TODO: ignore case and non-alphanumerics"); }
`);
write("tests/text_test.ts", `import { eq } from "./assert.ts";
import { isPalindrome, slugify, titleCase, truncate, wordCount } from "../src/text.ts";
Deno.test("slugify", () => { eq(slugify("  Hello, World!  "), "hello-world"); eq(slugify("A -- B"), "a-b"); });
Deno.test("wordCount", () => { eq(wordCount("  one two\\tthree\\n"), 3); eq(wordCount(""), 0); });
Deno.test("titleCase", () => { eq(titleCase("hELLO wORLD"), "Hello World"); });
Deno.test("truncate", () => { eq(truncate("abcdef", 4), "abc\\u2026"); eq(truncate("abc", 4), "abc"); });
Deno.test("isPalindrome", () => { eq(isPalindrome("A man, a plan, a canal: Panama"), true); eq(isPalindrome("abc"), false); });
`);
write("src/dates.ts", `// Calendar helpers on ISO dates (YYYY-MM-DD), proleptic Gregorian, no time zones.
export function isLeapYear(y: number): boolean { throw new Error("TODO"); }
export function daysInMonth(y: number, m: number): number { throw new Error("TODO: m is 1-12"); }
export function addDays(iso: string, n: number): string { throw new Error("TODO"); }
export function weekday(iso: string): string { throw new Error("TODO: Monday..Sunday"); }
export function diffDays(a: string, b: string): number { throw new Error("TODO: b - a in days"); }
`);
write("tests/dates_test.ts", `import { eq } from "./assert.ts";
import { addDays, daysInMonth, diffDays, isLeapYear, weekday } from "../src/dates.ts";
Deno.test("isLeapYear", () => { eq([1900, 2000, 2024, 2026].map(isLeapYear), [false, true, true, false]); });
Deno.test("daysInMonth", () => { eq(daysInMonth(2024, 2), 29); eq(daysInMonth(2026, 4), 30); });
Deno.test("addDays", () => { eq(addDays("2026-12-30", 3), "2027-01-02"); eq(addDays("2024-03-01", -1), "2024-02-29"); });
Deno.test("weekday", () => { eq(weekday("2026-10-23"), "Friday"); });
Deno.test("diffDays", () => { eq(diffDays("2026-01-01", "2026-12-31"), 364); });
`);
write("src/version.ts", `export const VERSION = "0.0.0";\n`);
write("README.md", `# demo-lib\n\nSmall helper library used to test DeepSeek Harness.\n\n## Modules\n\n- stats\n- text\n- dates\n`);
write(".gitignore", "vendor-cache/\n");
write("vendor-cache/keep.txt", "shared dependency cache: must survive cleanup\n");
sh("git", ["add", "-A"]);
sh("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "commit", "-qm", "demo scaffold"]);
// An uncommitted edit before dispatch: the default snapshot base must carry it to the workers.
write("src/index.ts", `export * from "./stats.ts";\nexport * from "./text.ts";\nexport * from "./dates.ts";\nexport * from "./version.ts";\n`);

// ---- MCP client ----
const child = new Deno.Command("deno", {
  args: ["run", "-A", "--no-config", "--quiet", server],
  env: { DSH_HOME: home, DENO_NO_UPDATE_CHECK: "1" },
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
}).spawn();
const writer = child.stdin.getWriter();
const pending = new Map<number, (v: any) => void>();
let nextId = 1;
(async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of child.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      } else if (msg.method === "notifications/progress") {
        console.log(`  · progress: ${msg.params.message}`);
      }
    }
  }
})();
function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  const p = new Promise((res) => pending.set(id, res));
  writer.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
  return p;
}
async function tool(name: string, args: unknown): Promise<string> {
  const t0 = Date.now();
  const r = await rpc("tools/call", { name, arguments: args, _meta: { progressToken: `p${nextId}` } });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  console.log(`\n===== ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${r.result?.isError ? " [isError]" : ""}\n${text}`);
  if (r.result?.isError) throw new Error(`${name} failed`);
  return text;
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
console.log("initialize:", init.result.serverInfo, init.result.protocolVersion);
const list = await rpc("tools/list", {});
console.log("tools:", list.result.tools.map((t: any) => t.name).join(", "));

const t0 = Date.now();
const d = await tool("dispatch", {
  repo,
  maxParallel: 5,
  context: "Deno + TypeScript, no external imports. Keep the existing exported signatures. Run tests with: deno test --no-config <file>.",
  verify: "deno test --no-config tests/",
  link: ["vendor-cache"],
  tasks: [
    { id: "stats", title: "Implement src/stats.ts", prompt: "Implement every function in src/stats.ts so tests/stats_test.ts passes. Follow the comments in the file.", files: ["src/stats.ts"], verify: "deno test --no-config tests/stats_test.ts" },
    { id: "text", title: "Implement src/text.ts and document it", prompt: "Implement every function in src/text.ts so tests/text_test.ts passes. Then append a section `## text module` at the end of README.md with one bullet per function.", files: ["src/text.ts", "README.md"], verify: "deno test --no-config tests/text_test.ts" },
    { id: "dates", title: "Implement src/dates.ts", prompt: "Implement every function in src/dates.ts so tests/dates_test.ts passes. Use UTC Date arithmetic or pure integer math.", files: ["src/dates.ts"], verify: "deno test --no-config tests/dates_test.ts" },
    { id: "bump-a", title: "Set version 1.1.0", prompt: 'In src/version.ts change VERSION to "1.1.0". Change nothing else and do not run anything.', files: ["src/version.ts"], effort: "low", verify: "" },
    { id: "bump-b", title: "Set version 2.0.0", prompt: 'In src/version.ts change VERSION to "2.0.0". Change nothing else and do not run anything.', files: ["src/version.ts"], effort: "low", verify: "" },
  ],
});
const runId = d.match(/run (\d{4}-\d{4}-[a-z0-9]+)/)![1];

// The orchestrator keeps working in the main tree while the workers run.
write("README.md", Deno.readTextFileSync(`${repo}/README.md`).replace("# demo-lib\n", "# demo-lib\n\n> Edited in the main tree while the workers ran.\n"));

let s = "";
do {
  s = await tool("wait", { runId, mode: "any", timeoutSec: 240 });
} while (!s.includes("have finished"));
const wall = (Date.now() - t0) / 1000;

await tool("result", { runId, includeDiff: false });
await tool("result", { runId, taskIds: ["stats"], maxDiffChars: 3000 });

let integ = await tool("integrate", { runId, taskIds: ["stats", "text", "dates", "bump-a", "bump-b"] });
if (integ.includes("CONFLICT")) {
  const wt = `${home}${sep}wt${sep}${runId}${sep}_integration`;
  console.log("\n--- conflicted file in the integration worktree:\n" + Deno.readTextFileSync(`${wt}/src/version.ts`));
  Deno.writeTextFileSync(`${wt}/src/version.ts`, `export const VERSION = "2.0.0";\n`);
  integ = await tool("integrate", { runId, continue: true });
}
await tool("land", { runId, dryRun: true });
await tool("land", { runId });

console.log("\n--- main tree after land: git status\n" + sh("git", ["status", "--short"]));
const readme = Deno.readTextFileSync(`${repo}/README.md`);
console.log("--- README.md\n" + readme);
const checks: [string, boolean][] = [
  ["README keeps the main-tree edit", readme.includes("Edited in the main tree while the workers ran.")],
  ["README has the worker's section", readme.includes("## text module")],
  ["README has no conflict markers", !/^(<<<<<<<|>>>>>>>)/m.test(readme)],
  ["src/stats.ts kept LF line endings", !Deno.readTextFileSync(`${repo}/src/stats.ts`).includes("\r\n")],
  ["src/version.ts is 2.0.0", Deno.readTextFileSync(`${repo}/src/version.ts`).includes('"2.0.0"')],
  ["nothing was committed to master", sh("git", ["rev-list", "--count", "HEAD"]).trim() === "1"],
];
let testOut = "";
try {
  testOut = sh("deno", ["test", "--no-config", "tests/"]);
} catch (e) {
  testOut = String(e);
}
console.log("--- deno test in the main tree:\n" + testOut.split("\n").slice(-6).join("\n"));
checks.push(["all tests pass in the main tree", /ok \| 15 passed \| 0 failed/.test(testOut)]);

await tool("cleanup", { runId });
checks.push(["shared vendor-cache survived cleanup", (() => {
  try {
    return Deno.readTextFileSync(`${repo}/vendor-cache/keep.txt`).length > 0;
  } catch {
    return false;
  }
})()]);
checks.push(["no dsh/* branches left", sh("git", ["branch", "--list", "dsh/*"]).trim() === ""]);
checks.push(["only the main worktree left", sh("git", ["worktree", "list"]).trim().split("\n").length === 1]);
console.log(`\nDispatch-to-all-done wall time: ${wall.toFixed(0)}s`);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : "All checks passed");
await writer.close();
await child.status;
Deno.exit(failed ? 1 : 0);
