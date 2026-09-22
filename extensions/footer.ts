import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
/* Footer layout adapted from Pi's FooterComponent.
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.*/
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000)
		return count.toString();
	if (count < 10000)
		return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000)
		return `${Math.round(count / 1000)}k`;
	if (count < 10000000)
		return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home)
		return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome = relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome)
		return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: {
		total: number;
	};
}
interface AccountingEntry {
	type: string;
	name?: string;
	usage?: Usage;
	message?: {
		role: string;
		usage?: Usage;
	};
}
export function summarizeEntries(entries: readonly AccountingEntry[]) {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	let name: string | undefined;
	for (const entry of entries) {
		if (entry.type === "session_info")
			name = entry.name?.trim() || undefined;
		const message = entry.type === "message" ? entry.message : undefined;
		const usage = message?.role === "assistant" || message?.role === "toolResult"
			? message.usage
			: ["usage", "compaction", "branch_summary"].includes(entry.type) ? entry.usage : undefined;
		if (!usage)
			continue;
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
			totals[key] += usage[key];
		totals.cost += usage.cost.total;
		if (message?.role === "assistant") {
			const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
			latestCacheHitRate = prompt > 0 ? usage.cacheRead / prompt * 100 : undefined;
		}
	}
	return { totals, latestCacheHitRate, name };
}
export interface FooterOptions {
	autoCompact: boolean;
	subscription: boolean;
}
// Only small configuration files are checked, at most once per second. Session
// history is never polled from disk, and unchanged files are never re-parsed.
interface FileOptions {
	autoCompact?: boolean;
	oauthProviders?: Set<string>;
}
interface SubscriptionRegistry {
	getProvider?: (id: string) => { auth?: { oauth?: { isSubscription?: boolean } } } | undefined;
}
export function createOptionsReader(ctx: ExtensionContext): () => FooterOptions {
	const files = new Map<string, { stamp: string; value: FileOptions }>();
	let checkedAt = -Infinity;
	let provider: string | undefined;
	let options: FooterOptions = { autoCompact: true, subscription: false };
	function read(path: string, auth = false): FileOptions {
		try {
			const stat = statSync(path);
			const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
			const cached = files.get(path);
			if (cached?.stamp === stamp) return cached.value;
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			// Retain credential types only, never tokens or API keys.
			const value: FileOptions = auth ? {
				oauthProviders: new Set(Object.entries(parsed ?? {}).filter(([, credential]) =>
					credential && typeof credential === "object" && "type" in credential && credential.type === "oauth"
				).map(([id]) => id)),
			} : { autoCompact: typeof parsed?.compaction?.enabled === "boolean" ? parsed.compaction.enabled : undefined };
			files.set(path, { stamp, value });
			return value;
		} catch { files.delete(path); return {}; }
	}
	return () => {
		const now = Date.now();
		if (now - checkedAt < 1000 && provider === ctx.model?.provider) return options;
		checkedAt = now;
		provider = ctx.model?.provider;
		const agentDir = getAgentDir();
		const global = read(join(agentDir, "settings.json"));
		const project = ctx.isProjectTrusted() ? read(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) : {};
		const oauth = provider ? read(join(agentDir, "auth.json"), true).oauthProviders?.has(provider) : false;
		const registry = ctx.modelRegistry as typeof ctx.modelRegistry & SubscriptionRegistry;
		const subscription = provider && registry.getProvider
			? registry.getProvider(provider)?.auth?.oauth?.isSubscription === true : true;
		options = {
			autoCompact: project.autoCompact ?? global.autoCompact ?? true,
			subscription: provider === "kimi-coding" || Boolean(oauth && subscription),
		};
		return options;
	};
}
export function createCachedFooter(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "getThinkingLevel">, footerData: ReadonlyFooterDataProvider, getOptions: () => FooterOptions) {
	let snapshotKey: string | undefined;
	let snapshot: ReturnType<typeof summarizeEntries>;
	let contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
	let renderKey: string | undefined;
	let lines: string[] = [];
	return {
		invalidate() { renderKey = undefined; },
		invalidateStats() { snapshotKey = undefined; renderKey = undefined; },
		render(width: number): string[] {
			if (width <= 0)
				return [];
			const state = { model: ctx.model, thinkingLevel: pi.getThinkingLevel() };
			const key = JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), state.model?.provider, state.model?.id, state.model?.contextWindow]);
			if (snapshotKey !== key) {
				snapshot = summarizeEntries(ctx.sessionManager.getEntries());
				contextUsage = ctx.getContextUsage();
				snapshotKey = key;
				renderKey = undefined;
			}
			const options = getOptions();
			const branch = footerData.getGitBranch();
			const statuses = [...footerData.getExtensionStatuses()];
			const nextRenderKey = JSON.stringify([width, key, state.thinkingLevel, state.model?.reasoning, ctx.cwd, branch, statuses, footerData.getAvailableProviderCount(), options]);
			if (renderKey === nextRenderKey)
				return lines;
			const theme = ctx.ui.theme;
			const usageTotals = snapshot.totals;
			const latestCacheHitRate = snapshot.latestCacheHitRate;
			const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
			const contextPercentValue = contextUsage?.percent ?? 0;
			const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
			let pwd = formatCwdForFooter(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
			if (branch)
				pwd += ` (${branch})`;
			if (snapshot.name)
				pwd += ` • ${snapshot.name}`;
			// Build stats line
			const statsParts = [];
			if (usageTotals.input)
				statsParts.push(`↑${formatTokens(usageTotals.input)}`);
			if (usageTotals.output)
				statsParts.push(`↓${formatTokens(usageTotals.output)}`);
			if (usageTotals.cacheRead)
				statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
			if (usageTotals.cacheWrite)
				statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
			if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
				statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
			}
			// Kimi Coding is subscription-backed despite using API-key authentication.
			const usingSubscription = state.model
				? state.model.provider === "kimi-coding" || options.subscription
				: false;
			if (usageTotals.cost || usingSubscription) {
				const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
				statsParts.push(costStr);
			}
			// Colorize context percentage based on usage
			let contextPercentStr: string;
			const autoIndicator = options.autoCompact ? " (auto)" : "";
			const contextPercentDisplay = contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
			if (contextPercentValue > 90) {
				contextPercentStr = theme.fg("error", contextPercentDisplay);
			}
			else if (contextPercentValue > 70) {
				contextPercentStr = theme.fg("warning", contextPercentDisplay);
			}
			else {
				contextPercentStr = contextPercentDisplay;
			}
			statsParts.push(contextPercentStr);
			if (process.env.PI_EXPERIMENTAL === "1")
				statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
			let statsLeft = statsParts.join(" ");
			// Add model name on the right side, plus thinking level if model supports it
			const modelName = state.model?.id || "no-model";
			let statsLeftWidth = visibleWidth(statsLeft);
			// If statsLeft is too wide, truncate it
			if (statsLeftWidth > width) {
				statsLeft = truncateToWidth(statsLeft, width, "...");
				statsLeftWidth = visibleWidth(statsLeft);
			}
			// Calculate available space for padding (minimum 2 spaces between stats and model)
			const minPadding = 2;
			// Add thinking level indicator if model supports reasoning
			let rightSideWithoutProvider = modelName;
			if (state.model?.reasoning) {
				const thinkingLevel = state.thinkingLevel || "off";
				rightSideWithoutProvider =
					thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
			}
			// Prepend the provider in parentheses if there are multiple providers and there's enough room
			let rightSide = rightSideWithoutProvider;
			if (footerData.getAvailableProviderCount() > 1 && state.model) {
				rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
				if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
					// Too wide, fall back
					rightSide = rightSideWithoutProvider;
				}
			}
			const rightSideWidth = visibleWidth(rightSide);
			const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
			let statsLine: string;
			if (totalNeeded <= width) {
				// Both fit - add padding to right-align model
				const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
				statsLine = statsLeft + padding + rightSide;
			}
			else {
				// Need to truncate right side
				const availableForRight = width - statsLeftWidth - minPadding;
				if (availableForRight > 0) {
					const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
					const truncatedRightWidth = visibleWidth(truncatedRight);
					const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
					statsLine = statsLeft + padding + truncatedRight;
				}
				else {
					// Not enough space for right side at all
					statsLine = statsLeft;
				}
			}
			// Apply dim to each part separately. statsLeft may contain color codes (for context %)
			// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
			// before and after the colored section independently.
			const dimStatsLeft = theme.fg("dim", statsLeft);
			const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
			const dimRemainder = theme.fg("dim", remainder);
			const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
			lines = [pwdLine, dimStatsLeft + dimRemainder];
			// Add extension statuses on a single line, sorted by key alphabetically
			const extensionStatuses = footerData.getExtensionStatuses();
			if (extensionStatuses.size > 0) {
				const sortedStatuses = Array.from(extensionStatuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text));
				const statusLine = sortedStatuses.join(" ");
				// Truncate to terminal width with dim ellipsis for consistency with footer style
				lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			}
			renderKey = nextRenderKey;
			return lines;
		},
	};
}
export default function cachedFooterExtension(pi: ExtensionAPI) {
	let enabled = true;
	let footer: ReturnType<typeof createCachedFooter> | undefined;
	let requestRender: (() => void) | undefined;
	function install(ctx: ExtensionContext) {
		if (!ctx.hasUI)
			return;
		ctx.ui.setFooter((tui, _theme, data) => {
			const current = createCachedFooter(ctx, pi, data, createOptionsReader(ctx));
			footer = current;
			requestRender = () => tui.requestRender();
			const unsubscribe = data.onBranchChange(requestRender);
			return {
				render: current.render,
				invalidate: current.invalidate,
				dispose() {
					unsubscribe();
					if (footer === current) {
						footer = undefined;
						requestRender = undefined;
					}
				},
			};
		});
	}
	pi.on("session_start", (_event, ctx) => {
		if (enabled)
			install(ctx);
	});
	const refresh = () => { footer?.invalidateStats(); requestRender?.(); };
	pi.on("message_end", refresh);
	pi.on("turn_end", refresh);
	pi.on("agent_end", refresh);
	pi.on("session_tree", refresh);
	pi.on("session_compact", refresh);
	pi.on("model_select", refresh);
	pi.on("session_shutdown", () => { footer = undefined; requestRender = undefined; });
	pi.registerCommand("cc-footer", {
		description: "Toggle cached footer (on/off)",
		handler: async (args, ctx) => {
			if (args.trim() && !["on", "off"].includes(args.trim())) {
				ctx.ui.notify("Usage: /cc-footer [on|off]", "warning");
				return;
			}
			enabled = args.trim() ? args.trim() === "on" : !enabled;
			if (enabled)
				install(ctx);
			else
				ctx.ui.setFooter(undefined);
			ctx.ui.notify(`Cached footer ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
