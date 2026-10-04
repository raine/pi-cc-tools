import { AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, ProcessTerminal, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

initTheme("dark", false);

// Load the extension onto a fake pi so the render patches apply.
const fakePi = {
	tools: new Map(), commands: new Map(), handlers: new Map<string, any[]>(),
	registerTool(d: any) { this.tools.set(d.name, d); },
	registerCommand(n: string, c: any) { this.commands.set(n, c); },
	registerShortcut(_k: string, _s: any) {},
	on(n: string, h: any) { this.handlers.set(n, [...(this.handlers.get(n) ?? []), h]); },
	getThinkingLevel() { return "off"; },
	getAllTools() { return [...this.tools.values()]; },
};
const magicContextToolNames = ["ctx_search", "ctx_memory", "ctx_note", "ctx_expand", "ctx_reduce", "todowrite"];
class TestMouseRegion {
	constructor(public child: any) {}
	render(width: number) { return this.child.render(width); }
	invalidate() { this.child.invalidate?.(); }
}
let wrapAssistantMarkdown = false;
const baseAssistantUpdateContent = AssistantMessageComponent.prototype.updateContent;
AssistantMessageComponent.prototype.updateContent = function testWrappedUpdateContent(...args: any[]) {
	const result = baseAssistantUpdateContent.apply(this, args as any);
	if (wrapAssistantMarkdown) {
		const children = (this as any).contentContainer?.children;
		if (Array.isArray(children)) {
			for (let i = 0; i < children.length; i++) {
				if (children[i] instanceof Markdown || children[i]?.constructor?.name === "Markdown") {
					children[i] = new TestMouseRegion(children[i]);
				}
			}
		}
	}
	return result;
};
const oldMagicRenderCall = () => new Container();
const oldMagicRenderResult = () => new Container();
for (const name of magicContextToolNames) {
	fakePi.registerTool({
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {},
		execute: async (_id: string, params: any) => ({ content: [{ type: "text", text: `${name}:${params.value}` }] }),
		renderCall: oldMagicRenderCall,
		renderResult: oldMagicRenderResult,
	});
}
const ext = await import("../extensions/index.ts");
ext.default(fakePi as any);

const W = 120;

// Snapshot string-array output for comparison (copy so later mutations don't matter).
const snap = (v: string[]) => v.join("\n");
const eq = (a: string[], b: string[], label: string) => {
	if (snap(a) !== snap(b)) throw new Error(`MISMATCH: ${label}`);
};
const neq = (a: string[], b: string[], label: string) => {
	if (snap(a) === snap(b)) throw new Error(`UNEXPECTED EQUAL: ${label}`);
};

// ---------------------------------------------------------------------------
// 1. Assistant message: cache hit is byte-identical; updateContent invalidates.
// ---------------------------------------------------------------------------
{
	const msg = {
		role: "assistant",
		content: [{ type: "text", text: "Hello world\n\n- one\n- two\n\n```ts\nconst x = 1;\n```" }],
		stopReason: "end_turn",
	};
	const c = new AssistantMessageComponent(msg as any, false);
	const a = c.render(W);
	const b = c.render(W); // warm → cache hit
	eq(b, a, "assistant: warm cache hit must equal cold render");

	// Mutate content via updateContent; cache must invalidate.
	const msg2 = {
		role: "assistant",
		content: [{ type: "text", text: "Completely different content that should produce different lines." }],
		stopReason: "end_turn",
	};
	c.updateContent(msg2 as any);
	const d = c.render(W);
	neq(d, a, "assistant: updateContent did NOT invalidate the render cache (stale output)");
	const e = c.render(W); // warm again after recompute
	eq(e, d, "assistant: warm cache hit after updateContent must equal the recompute");
	console.log("OK  assistant message: cache identical + updateContent invalidates");
}

// ---------------------------------------------------------------------------
// 2. User message: immutable content → deterministic across renders.
// ---------------------------------------------------------------------------
{
	const c = new UserMessageComponent("User asks a question with **bold** and `code`.");
	const a = c.render(W);
	const b = c.render(W);
	eq(b, a, "user: warm cache hit must equal cold render");
	console.log("OK  user message: cache identical across renders");
}

// ---------------------------------------------------------------------------
// 3. Custom message: rebuild() invalidates.
// ---------------------------------------------------------------------------
{
	const message = { customType: "subagent-notification", content: "✓ Done\n⎿ transcript: foo" };
	const c = new CustomMessageComponent(message as any, undefined as any);
	const a = c.render(W);
	const b = c.render(W);
	eq(b, a, "custom: warm cache hit must equal cold render");
	// invalidate() → rebuild() → cache cleared
	c.invalidate();
	const d = c.render(W);
	eq(d, a, "custom: after invalidate output should still be equivalent (same content)");
	const e = c.render(W);
	eq(e, d, "custom: warm cache hit after invalidate must equal recompute");
	console.log("OK  custom message: cache identical + rebuild invalidates");
}

// ---------------------------------------------------------------------------
// 4. Parent Container.render must NOT mutate the cached child array.
//    Render child, capture cached ref, wrap in a parent, render parent, then
//    re-render child and confirm the cached array is unchanged.
// ---------------------------------------------------------------------------
{
	const msg = { role: "assistant", content: [{ type: "text", text: "Line one\nLine two\nLine three" }], stopReason: "end_turn" };
	const child = new AssistantMessageComponent(msg as any, false);
	const first = child.render(W); // populates cache, returns cached ref
	const snapshot = snap(first);
	const parent = new Container();
	parent.addChild(child);
	parent.render(W); // spreads child's cached array — must not mutate it
	if (snap(first) !== snapshot) throw new Error("parent render mutated the child's cached array");
	if (snap(child.render(W)) !== snapshot) throw new Error("child cached array changed after parent render");
	console.log("OK  parent does not mutate cached child array");
}

// ---------------------------------------------------------------------------
// 5. Custom (subagent) message framing follows toolBackgroundMode. Switching
//    mode must invalidate the cached framing. Uses an isolated temp HOME so the
//    real ~/.pi/settings.json is never touched.
// ---------------------------------------------------------------------------
{
	const realHome = process.env.HOME;
	const tmpHome = `${realHome}/.pi-cache-test-home-${Date.now()}`;
	const fs = await import("node:fs");
	fs.mkdirSync(`${tmpHome}/.pi`, { recursive: true });
	process.env.HOME = tmpHome;
	try {
		const ccTools = (fakePi as any).commands.get("cc-tools");
		if (!ccTools) throw new Error("cc-tools command not registered");
		const ctx = { hasUI: true, ui: { theme, notify() {}, getToolsExpanded() { return false; }, setToolsExpanded() {} } } as any;
		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		// A full-width rule line (borderLine) is all '─' chars; branch connectors '└' are not.
		const hasFullWidthRule = (lines: string[]) =>
			lines.some((l) => { const p = stripAnsi(l); return /^─+$/.test(p) && p.length > 5; });

		// Start in outlines mode (default). Render subagent msg → has full-width border rules.
		ccTools.handler("outlines", ctx);
		const message = { customType: "subagent-notification", content: "✓ Done\n⎿ transcript: foo" };
		const c = new CustomMessageComponent(message as any, undefined as any);
		const outlines = c.render(W);
		const outlinesWarm = c.render(W);
		eq(outlinesWarm, outlines, "custom: warm cache identical in outlines mode");
		if (!hasFullWidthRule(outlines)) {
			throw new Error("outlines mode did not produce full-width border rule lines");
		}

		// Switch to default mode (no borders). Cache must miss and reframe.
		ccTools.handler("default", ctx);
		const def = c.render(W);
		neq(def, outlines, "custom: switching toolBackgroundMode did NOT reframe (stale cache)");
		if (hasFullWidthRule(def)) {
			throw new Error("default mode still shows full-width border rule lines");
		}
		const defWarm = c.render(W);
		eq(defWarm, def, "custom: warm cache identical in default mode");

		// Switch back to outlines — must reframe again.
		ccTools.handler("outlines", ctx);
		const outlinesAgain = c.render(W);
		eq(outlinesAgain, outlines, "custom: switching back to outlines did not restore original framing");
		console.log("OK  custom message: toolBackgroundMode change invalidates framing");
	} finally {
		process.env.HOME = realHome;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 6. Magic Context tool definitions are re-registered with local renderers.
// ---------------------------------------------------------------------------
{
	const sessionStartHandlers = (fakePi as any).handlers.get("session_start") ?? [];
	if (sessionStartHandlers.length === 0) throw new Error("session_start handler not registered");
	for (const handler of sessionStartHandlers) await handler({}, { hasUI: false });
	for (const name of magicContextToolNames) {
		const tool = (fakePi as any).tools.get(name);
		if (!tool) throw new Error(`${name} was not preserved during override registration`);
		if (tool.renderCall === oldMagicRenderCall || tool.renderResult === oldMagicRenderResult) {
			throw new Error(`${name} kept its old Magic Context renderer`);
		}
		const result = await tool.execute("test", { value: "ok" }, undefined, undefined, {});
		if (result.content?.[0]?.text !== `${name}:ok`) throw new Error(`${name} execute behavior changed`);
	}
	console.log("OK  Magic Context tools: local renderers replace extension defaults");
}

// ---------------------------------------------------------------------------
// 7. Magic Context todo overlay receives local branch chrome and one indent.
// ---------------------------------------------------------------------------
{
	const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	const widget = new Container();
	widget.addChild({
		render: () => [
			theme.fg("accent", "● Todos — 1/2 completed"),
			`${theme.fg("dim", "├─")} ${theme.fg("success", "✓")} #done Done`,
			`${theme.fg("dim", "└─")} ${theme.fg("warning", "◐")} #next Next`,
		],
		invalidate() {},
	} as any);
	const lines = widget.render(W);
	const plain = lines.map(stripAnsi);
	if (plain[0] !== " ● Todos — 1/2 completed") throw new Error("todo overlay heading did not gain one indent");
	if (plain[1] !== " ├ ✓ done Done" || plain[2] !== " └ ◐ next Next") {
		throw new Error("todo overlay branch rows did not strip arm, indent, and remove todo ID hashes");
	}
	if (!lines[1].includes("\x1b[38;")) throw new Error("todo overlay branch did not receive branch chrome");
	console.log("OK  todo overlay: branch chrome + one indent");
}

// ---------------------------------------------------------------------------
// 7. Hermes auto-review notice is restyled locally without changing Hermes.
// ---------------------------------------------------------------------------
{
	const notices: string[] = [];
	const ui = {
		theme,
		notify(message: string) { notices.push(message); },
		getToolsExpanded() { return false; },
		setToolsExpanded() {},
	};
	const turnStart = (fakePi as any).handlers.get("turn_start")?.[0];
	if (!turnStart) throw new Error("turn_start handler not registered");
	await turnStart({}, { hasUI: true, ui });
	ui.notify("💾 Memory auto-reviewed and updated");
	const notice = notices.at(-1) ?? "";
	if (!notice.includes("✻ Memory auto-reviewed and updated") || !notice.includes("\x1b[38;") || notice.includes("\x1b[2m")) {
		throw new Error("Hermes auto-review notice did not adopt thinking-text color without extra dimming");
	}
	console.log("OK  Hermes notice: thinking-text color without extra dimming");
}

// Transient context tags stay out of rendered tool output without changing stored results.
{
	const result = { content: [{ type: "text", text: "§42§ Hidden metadata\nVisible result" }], details: {} };
	const tool = new ToolExecutionComponent("custom_tool", "tagged-result", {},
		{ showImages: false }, undefined, { requestRender() {} } as any, process.cwd());
	tool.setArgsComplete();
	tool.updateResult(result as any, false);
	const plain = tool.render(W).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.includes("§42§")) throw new Error("tool result exposed a transient context tag");
	if (result.content[0].text !== "§42§ Hidden metadata\nVisible result") {
		throw new Error("tool result sanitization mutated stored content");
	}
	console.log("OK  Magic Context results: tags hidden without stored-content mutation");
}

// The terminal writer removes tags from display-only surfaces that bypass renderers.
{
	const writes: string[] = [];
	const originalWrite = process.stdout.write;
	(process.stdout as any).write = (data: any) => { writes.push(String(data)); return true; };
	try {
		new ProcessTerminal().write("before §17§ after");
	} finally {
		(process.stdout as any).write = originalWrite;
	}
	if (writes.join("") !== "before  after") throw new Error("terminal writer did not scrub a context tag");
	console.log("OK  Magic Context terminal output: tags scrubbed at write time");
}

// Wrapped Markdown keeps its wrapper while receiving the local paragraph renderer.
{
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "Wrapped detailed reasoning." }],
		stopReason: "pending",
	};
	const comp = new AssistantMessageComponent(undefined as any, false);
	wrapAssistantMarkdown = true;
	try {
		(comp as any).updateContent(message);
	} finally {
		wrapAssistantMarkdown = false;
	}
	const container = (comp as any).contentContainer;
	const wrapper = container.children.find((child: any) => child instanceof TestMouseRegion);
	if (!wrapper) throw new Error("test setup did not wrap assistant Markdown");
	if (wrapper.child instanceof Markdown || wrapper.child?.constructor?.name === "Markdown") {
		throw new Error("wrapped Markdown did not receive the local paragraph renderer");
	}
	const plain = comp.render(W).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	if (!plain.includes("∴") || !plain.includes("Wrapped detailed reasoning.")) {
		throw new Error("wrapped thinking did not retain local expanded rendering");
	}
	console.log("OK  wrapped thinking: MouseRegion preserved with local rendering");
}

// Generic tool headers preview recognized arguments without repeating the label.
{
	const cases: Array<[string, any, string]> = [
		["suba_ping", { message: "Ready to merge. Approve integration?" }, "Suba Ping Ready to merge. Approve integration?"],
		["notify_user", { text: "Build complete" }, "Notify User Build complete"],
		["ask_review", { question: "Ship it?" }, "Ask Review Ship it?"],
		["create_item", { title: "Fix rendering" }, "Create Item Fix rendering"],
		["custom_tool", { message: "  ", text: "Useful fallback" }, "Custom Tool Useful fallback"],
		["custom_tool", { path: "file.ts", message: "Other text" }, "Custom Tool file.ts"],
		["suba_done", {}, "Suba Done"],
		["custom_tool", { message: 42, token: "not a preview" }, "Custom Tool"],
		["custom_tool", { message: "First line\nSecond line" }, "Custom Tool First line Second line"],
		["custom_tool", { message: "x".repeat(100) }, `Custom Tool ${"x".repeat(69)}...`],
	];
	for (const [name, args, expected] of cases) {
		const tool = new ToolExecutionComponent(name, `test-${name}`, args,
			{ showImages: false }, undefined, { requestRender() {} } as any, process.cwd());
		tool.setArgsComplete();
		tool.updateResult({ content: [{ type: "text", text: "Waiting for input." }], details: {} } as any, false);
		for (const expanded of [false, true]) {
			tool.setExpanded(expanded);
			const plain = tool.render(120).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
			const header = plain.find((line) => line.includes(expected));
			if (!header || header.replace(/^[●○]\s*/, "") !== expected) {
				throw new Error(`generic header mismatch: ${JSON.stringify({ name, expanded, expected, plain })}`);
			}
		}
	}
	console.log("OK  generic tools: meaningful argument previews and label-only fallback");
}

// Codemode uses source headlines, nested-call details, and script output rather
// than treating the result as an opaque generic tool response.
{
	const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const includes = (text: string, expected: string) => {
		if (!text.includes(expected)) throw new Error(`codemode missing ${JSON.stringify(expected)}: ${text}`);
	};
	const code = '// @options: {"timeout_ms": 60000}\nconst results = await Promise.allSettled([\n  tools.read({path: "README.md"}),\n  tools.bash({command: "git status --short"})\n]);\ntext(results);';
	const tool = new ToolExecutionComponent("codemode", "test-codemode", { code },
		{ showImages: false }, undefined, { requestRender() {} } as any, process.cwd());
	tool.setArgsComplete();
	const result = {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.5 seconds\nOutput:\n" },
			{ type: "text", text: "printed script output" },
		],
		details: { calls: [
			{ name: "read", args: '{"path":"README.md"}', status: "ok", durationMs: 69 },
			{ name: "bash", args: '{"command":"git status --short"}', status: "running" },
		] },
	};
	for (const handler of (fakePi as any).handlers.get("agent_start") ?? []) await handler({}, {});
	tool.markExecutionStarted();
	tool.updateResult(result as any, true);
	includes(plain(tool.render(W)), "Bash git status --short");
	const group = new Container();
	group.addChild(tool);
	const other = new ToolExecutionComponent("codemode", "other-codemode", { code: 'text("other script");' },
		{ showImages: false }, undefined, { requestRender() {} } as any, process.cwd());
	other.setArgsComplete();
	other.updateResult({ content: [{ type: "text", text: "other output" }] } as any, false);
	group.addChild(other);
	includes(plain(group.render(W)), "const results = await Promise.allSettled([");
	includes(plain(group.render(W)), 'text("other script");');
	includes(plain(group.render(W)), "Bash git status --short");
	tool.updateResult({ ...result, details: { calls: [
		result.details.calls[0],
		{ name: "bash", args: '{"command":"git status --short"}', status: "error", error: "permission denied", durationMs: 1500 },
		{ name: "custom_tool", args: '{"query":"truncated...', status: "cancelled" },
		{ name: "models.classify", args: "{}", status: "ok", cost: 0.004 },
	] } } as any, false);
	for (const expanded of [false, true]) {
		tool.setExpanded(expanded);
		const rendered = plain(tool.render(W));
		includes(rendered, "Codemode const results = await Promise.allSettled([ · 6 lines");
		includes(rendered, "Read README.md");
		includes(rendered, "Bash git status --short (1s)");
		includes(rendered, "printed script output");
		includes(rendered, "truncated...");
		includes(rendered, "$0.0040");
		if (rendered.includes("Wall time")) throw new Error("codemode repeated script envelope");
		if (expanded) {
			includes(rendered, 'tools.read({path: "README.md"})');
			includes(rendered, "permission denied");
			for (const child of (group as any).children) child.setExpanded?.(true);
			includes(plain(group.render(W)), "permission denied");
		} else if (rendered.includes('tools.read({path: "README.md"})')) {
			throw new Error("collapsed codemode included full source");
		}
		for (const width of [20, 40, 80]) {
			for (const line of tool.render(width)) {
				if (visibleWidth(line) > width) throw new Error(`codemode exceeded width ${width}`);
			}
		}
	}
	tool.updateResult({ content: [{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
		{ type: "text", text: "partial output\nScript error:\nboom" }],
		details: { fullOutputPath: "/tmp/codemode-output.txt" }, isError: true } as any, false);
	includes(plain(tool.render(W)), "Script failed");
	includes(plain(tool.render(W)), "partial output");
	includes(plain(tool.render(W)), "boom");
	includes(plain(tool.render(W)), "Full output: /tmp/codemode-output.txt");
	tool.updateResult({ content: [{ type: "text", text: "Invalid options" }], details: {}, isError: true } as any, false);
	includes(plain(tool.render(W)), "Invalid options");
	tool.updateArgs({ code: 'text("changed script");' });
	tool.setArgsComplete();
	includes(plain(tool.render(W)), 'text("changed script");');
	for (const handler of (fakePi as any).handlers.get("agent_end") ?? []) await handler({}, {});
	console.log("OK  codemode: source, nested calls, groups, partials, errors, cache invalidation, and narrow widths");
}

console.log("\nAll correctness checks passed.");
