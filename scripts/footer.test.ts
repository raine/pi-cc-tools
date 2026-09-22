import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension, { createCachedFooter, createOptionsReader, summarizeEntries } from "../extensions/footer.ts";
const usage = { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.25 } };
function fixture() {
	const state = {
		leaf: "a", session: "one", scans: 0, contexts: 0, percent: 25 as number | null,
		branch: "main", thinking: "high", statuses: new Map<string, string>(),
		entries: [{ type: "message", message: { role: "assistant", usage } }] as Parameters<typeof summarizeEntries>[0],
		options: { autoCompact: true, subscription: true },
	};
	const ctx = {
		modelRegistry: {},
		isProjectTrusted: () => false,
		hasUI: true, cwd: "/project", model: { id: "test-model", provider: "test", reasoning: true, contextWindow: 200000 },
		ui: { theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text } },
		sessionManager: {
			getSessionId: () => state.session, getLeafId: () => state.leaf,
			getEntries: () => { state.scans++; return state.entries; },
		},
		getContextUsage: () => { state.contexts++; return { percent: state.percent, contextWindow: 200000, tokens: 50000 }; },
	} as unknown as ExtensionContext;
	const pi = { getThinkingLevel: () => state.thinking } as Pick<ExtensionAPI, "getThinkingLevel">;
	const data = {
		getGitBranch: () => state.branch, getExtensionStatuses: () => state.statuses,
		getAvailableProviderCount: () => 2, onBranchChange: () => () => { },
	} as ReadonlyFooterDataProvider;
	return { state, ctx, pi, data, footer: createCachedFooter(ctx, pi, data, () => state.options) };
}
test("spinner redraws reuse both statistics and rendered lines", () => {
	const { footer, state } = fixture();
	const first = footer.render(160);
	for (let i = 0;i < 10000;i++)
		assert.equal(footer.render(160), first);
	assert.equal(state.scans, 1);
	assert.equal(state.contexts, 1);
	assert.match(first[0], /\/project \(main\)/);
	assert.match(first[1], /↑100 ↓20 R900 CH90.0% \$0.250 \(sub\) 25.0%\/200k \(auto\)/);
	assert.match(first[1], /\(test\) test-model • high$/);
});
test("leaf, session, model and explicit invalidation refresh statistics", () => {
	const { footer, state, ctx } = fixture();
	footer.render(160);
	state.leaf = "b";
	footer.render(160);
	state.session = "two";
	footer.render(160);
	ctx.model = { ...ctx.model!, id: "other" };
	footer.render(160);
	state.percent = null;
	footer.invalidateStats();
	assert.match(footer.render(160)[1], /\?\/200k/);
	assert.equal(state.scans, 5);
	assert.equal(state.contexts, 5);
});
test("status, branch, settings, theme and width changes do not rescan history", () => {
	const { footer, state, ctx } = fixture();
	footer.render(160);
	state.statuses.set("mcp", "MCP: 1 server enabled");
	assert.equal(footer.render(160)[2], "MCP: 1 server enabled");
	state.branch = "other";
	assert.match(footer.render(160)[0], /\(other\)/);
	state.thinking = "low";
	assert.match(footer.render(160)[1], / • low$/);
	state.options.autoCompact = false;
	assert.doesNotMatch(footer.render(160)[1], /\(auto\)/);
	state.statuses.clear();
	assert.equal(footer.render(160).length, 2);
	ctx.ui.theme.fg = (_color, text) => `\x1b[31m${text}\x1b[0m`;
	footer.invalidate();
	assert.match(footer.render(160)[0], /\x1b\[31m/);
	for (const width of [1, 2, 3, 10, 40, 80, 160]) {
		for (const line of footer.render(width))
			assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
	assert.deepEqual(footer.render(0), []);
	assert.equal(state.scans, 1);
	assert.equal(state.contexts, 1);
});
test("totals include all branches, tools, summaries and standalone usage", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage } },
		{ type: "message", message: { role: "toolResult", usage } },
		{ type: "compaction", usage }, { type: "branch_summary", usage }, { type: "usage", usage },
		{ type: "custom", usage },
		{ type: "session_info", name: "old" }, { type: "session_info", name: "new" },
	];
	const snapshot = summarizeEntries(entries);
	assert.deepEqual(snapshot.totals, { input: 500, output: 100, cacheRead: 4500, cacheWrite: 0, cost: 1.25 });
	assert.equal(snapshot.latestCacheHitRate, 90);
	assert.equal(snapshot.name, "new");
	assert.equal(summarizeEntries([...entries, { type: "session_info", name: "" }]).name, undefined);
});
test("extension installs, toggles, unsubscribes and invalidates on lifecycle events", async () => {
	const { ctx, pi, data, state } = fixture();
	const events = new Map<string, Function>();
	let command: any;
	let current: any;
	let unsubscribed = 0;
	data.onBranchChange = () => () => { unsubscribed++; };
	ctx.ui.notify = () => { };
	ctx.ui.setFooter = (factory) => {
		current?.dispose();
		current = factory?.({ requestRender() { } } as any, ctx.ui.theme, data);
	};
	extension({ ...pi, on: (name: string, fn: Function) => events.set(name, fn), registerCommand: (_name: string, value: any) => { command = value; } } as unknown as ExtensionAPI);
	events.get("session_start")!({}, ctx);
	assert.ok(current);
	current.render(100);
	for (const event of ["message_end", "turn_end", "agent_end", "session_tree", "session_compact", "model_select"]) {
		const before = state.scans;
		events.get(event)!({}, ctx);
		current.render(100);
		assert.equal(state.scans, before + 1);
	}
	await command.handler("off", ctx);
	assert.equal(current, undefined);
	assert.equal(unsubscribed, 1);
	await command.handler("on", ctx);
	assert.ok(current);
});


test("settings honor project trust and credential types without timers", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-footer-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ test: { type: "oauth", access: "not-retained" } }));
		const { ctx } = fixture();
		ctx.cwd = join(dir, "project");
		mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
		writeFileSync(join(ctx.cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
		assert.deepEqual(createOptionsReader(ctx)(), { autoCompact: false, subscription: true });
		ctx.isProjectTrusted = () => true;
		assert.deepEqual(createOptionsReader(ctx)(), { autoCompact: true, subscription: true });
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "not-retained" } }));
		assert.equal(createOptionsReader(ctx)().subscription, false);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
