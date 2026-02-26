/**
 * Antigravity Pulse – Ultra-minimal VS Code extension
 *
 * Shows your Antigravity model quota in the status bar, grouped
 * by pool (Gemini · Claude/GPT).
 *
 * Each pool gets a color indicator (🟢/🟡/🔴) that changes based on remaining quota.
 */

import * as vscode from 'vscode';
import { findAntigravityProcess, ProcessInfo } from './process-finder';
import { fetchQuota, QuotaSnapshot } from './quota-fetcher';

let statusBarItem: vscode.StatusBarItem;
let pollingTimer: ReturnType<typeof setInterval> | undefined;
let processInfo: ProcessInfo | null = null;
let lastSnapshot: QuotaSnapshot | null = null;

// ─── Activate ───────────────────────────────────────────────────────

export async function activate(ctx: vscode.ExtensionContext) {
    // Status bar – right-aligned, high priority
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    statusBarItem.command = 'antigravityPulse.refresh';
    ctx.subscriptions.push(statusBarItem);

    // Commands
    ctx.subscriptions.push(
        vscode.commands.registerCommand('antigravityPulse.refresh', async () => {
            showLoading();
            if (!processInfo) { await detectProcess(); }
            await refreshQuota();
            showRefreshConfirmation();
        }),
        vscode.commands.registerCommand('antigravityPulse.toggleClockFormat', async () => {
            const cfg = vscode.workspace.getConfiguration('antigravityPulse');
            const current = cfg.get<string>('clockFormat', 'auto');
            const next = current === 'auto' ? '12h' : current === '12h' ? '24h' : 'auto';
            await cfg.update('clockFormat', next, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Clock format: ${next}`);
            if (lastSnapshot) { updateStatusBar(lastSnapshot); }
        }),
        vscode.commands.registerCommand('antigravityPulse.toggleResetTime', async () => {
            const cfg = vscode.workspace.getConfiguration('antigravityPulse');
            const current = cfg.get<boolean>('showResetTime', false);
            await cfg.update('showResetTime', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Reset time in status bar: ${!current ? 'on' : 'off'}`);
            if (lastSnapshot) { updateStatusBar(lastSnapshot); }
        })
    );

    // Show loading state
    showLoading();

    // Non-blocking init
    detectAndStart();
}

// ─── Deactivate ─────────────────────────────────────────────────────

export function deactivate() {
    stopPolling();
    statusBarItem?.dispose();
}

// ─── Core loop ──────────────────────────────────────────────────────

async function detectAndStart() {
    await detectProcess();
    if (processInfo) {
        await refreshQuota();
        startPolling();
    } else {
        showError('Antigravity not found');
    }
}

async function detectProcess() {
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    processInfo = await findAntigravityProcess(wsPath);
}

async function refreshQuota() {
    if (!processInfo) {
        showError('No connection');
        return;
    }

    try {
        const snapshot = await fetchQuota(processInfo.port, processInfo.csrfToken);
        lastSnapshot = snapshot;
        updateStatusBar(snapshot);
    } catch {
        // Process might have restarted – re-detect once
        processInfo = await findAntigravityProcess(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        if (processInfo) {
            try {
                const snapshot = await fetchQuota(processInfo.port, processInfo.csrfToken);
                lastSnapshot = snapshot;
                updateStatusBar(snapshot);
                return;
            } catch { /* fall through */ }
        }
        showError('Fetch failed');
    }
}

// ─── Polling ────────────────────────────────────────────────────────

function getIntervalMs(): number {
    const cfg = vscode.workspace.getConfiguration('antigravityPulse');
    return Math.max(30, cfg.get<number>('pollingInterval', 30)) * 1000;
}

function startPolling() {
    stopPolling();
    pollingTimer = setInterval(() => refreshQuota(), getIntervalMs());
}

function stopPolling() {
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = undefined; }
}

// ─── Status bar rendering ───────────────────────────────────────────

/** Compact pool labels for the status bar */
const POOL_SHORT: Record<string, string> = {
    all: 'All Models',
    gemini: 'Gemini',
    gemini_pro: 'Gem Pro',
    gemini_flash: 'Gem Flash',
    claude_gpt: 'Claude',
    other: 'Other',
};

function healthDot(pct: number): string {
    if (pct > 50) { return '🟢'; }
    if (pct > 20) { return '🟡'; }
    return '🔴';
}

function updateStatusBar(snap: QuotaSnapshot) {
    if (snap.pools.length > 0) {
        const cfg = vscode.workspace.getConfiguration('antigravityPulse');
        const showReset = cfg.get<boolean>('showResetTime', false);

        const parts: string[] = [];

        for (const pool of snap.pools) {
            const short = POOL_SHORT[pool.id] || pool.displayName;
            const pct = Math.round(pool.remainingPct);
            let part = `${healthDot(pool.remainingPct)} ${short} ${pct}%`;
            if (showReset && pool.timeUntilReset) {
                part += ` [${pool.timeUntilReset}]`;
            }
            parts.push(part);
        }

        statusBarItem.text = parts.join(' | ');
        statusBarItem.backgroundColor = undefined;

        // Rich Markdown tooltip
        statusBarItem.tooltip = buildTooltip(snap);

    } else {
        statusBarItem.text = '$(rocket) AG';
        statusBarItem.tooltip = 'Antigravity Pulse — no data yet';
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();
}

// ─── Markdown tooltip builder ───────────────────────────────────────

function clockOptions(): Intl.DateTimeFormatOptions {
    const fmt = vscode.workspace.getConfiguration('antigravityPulse').get<string>('clockFormat', 'auto');
    const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    if (fmt === '12h') { opts.hour12 = true; }
    else if (fmt === '24h') { opts.hour12 = false; }
    return opts;
}

function buildTooltip(snap: QuotaSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown('### Antigravity Quota\n\n');

    // ── Per-pool sections ──
    for (let i = 0; i < snap.pools.length; i++) {
        const pool = snap.pools[i];
        const pct = pool.remainingPct;
        const emoji = pct > 50 ? '🟢' : pct > 20 ? '🟡' : '🔴';
        const bar = visualBar(pct);

        const msUntilReset = pool.resetTime.getTime() - Date.now();
        const timeOpts = clockOptions();
        const resetLocal = msUntilReset > 86_400_000
            ? pool.resetTime.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
            pool.resetTime.toLocaleTimeString([], timeOpts)
            : pool.resetTime.toLocaleTimeString([], timeOpts);
        md.appendMarkdown(`**${emoji} ${pool.displayName}** — ${pct.toFixed(0)}%\n\n`);
        md.appendMarkdown(`\`${bar}\` resets in **${pool.timeUntilReset}** _(${resetLocal})_\n\n`);

        // Individual models within the pool
        if (pool.models.length > 1) {
            for (const m of pool.models) {
                const mEmoji = m.isExhausted ? '🔴' : m.remainingPct < 20 ? '🟡' : '⚪';
                md.appendMarkdown(`&nbsp;&nbsp;&nbsp;${mEmoji} ${m.label} — ${m.remainingPct.toFixed(0)}%\n\n`);
            }
        }

        // Separator between pools (but not after the last one)
        if (i < snap.pools.length - 1) {
            md.appendMarkdown('---\n\n');
        }
    }

    // Footer
    md.appendMarkdown('\n---\n\n');
    md.appendMarkdown('_Click to refresh_');

    return md;
}

function visualBar(pct: number): string {
    const total = 20;
    const filled = Math.round((pct / 100) * total);
    const empty = total - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

// ─── States ─────────────────────────────────────────────────────────

function showLoading() {
    statusBarItem.text = '$(sync~spin) AG';
    statusBarItem.tooltip = 'Antigravity Pulse — detecting process…';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
}

function showRefreshConfirmation() {
    // Brief visual confirmation that the refresh completed
    statusBarItem.text = '$(check) Refreshed';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();

    setTimeout(() => {
        if (lastSnapshot) {
            updateStatusBar(lastSnapshot);
        }
    }, 1500);
}

function showError(msg: string) {
    statusBarItem.text = '$(error) AG';
    statusBarItem.tooltip = `Antigravity Pulse — ${msg}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.show();
}
