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
import { fetchQuota, QuotaSnapshot, AICredit } from './quota-fetcher';

let statusBarItem: vscode.StatusBarItem;
let pollingTimer: ReturnType<typeof setInterval> | undefined;
let processInfo: ProcessInfo | null = null;
let lastSnapshot: QuotaSnapshot | null = null;
let windowFocused = true;

// ─── Activate ───────────────────────────────────────────────────────

export async function activate(ctx: vscode.ExtensionContext) {
    // Status bar – right-aligned, high priority
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    statusBarItem.command = 'antigravityPulse.showMenu';
    ctx.subscriptions.push(statusBarItem);

    // Commands
    ctx.subscriptions.push(
        vscode.commands.registerCommand('antigravityPulse.showMenu', () => showQuickMenu()),
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
            if (lastSnapshot) { updateStatusBar(lastSnapshot); }
        }),
        vscode.commands.registerCommand('antigravityPulse.toggleResetTime', async () => {
            const cfg = vscode.workspace.getConfiguration('antigravityPulse');
            const current = cfg.get<boolean>('showResetTime', false);
            await cfg.update('showResetTime', !current, vscode.ConfigurationTarget.Global);
            if (lastSnapshot) { updateStatusBar(lastSnapshot); }
        }),
        vscode.commands.registerCommand('antigravityPulse.toggleSmartPolling', async () => {
            const cfg = vscode.workspace.getConfiguration('antigravityPulse');
            const current = cfg.get<boolean>('smartPolling', true);
            await cfg.update('smartPolling', !current, vscode.ConfigurationTarget.Global);
            // Apply immediately: if disabling smart polling while unfocused, restart polling
            if (current && !windowFocused) {
                startPolling();
            }
        }),
        vscode.commands.registerCommand('antigravityPulse.cycleDisplayMode', async () => {
            const cfg = vscode.workspace.getConfiguration('antigravityPulse');
            const current = cfg.get<string>('displayMode', 'full');
            const next = current === 'full' ? 'compact' : 'full';
            await cfg.update('displayMode', next, vscode.ConfigurationTarget.Global);
            if (lastSnapshot) { updateStatusBar(lastSnapshot); }
        }),
        vscode.commands.registerCommand('antigravityPulse.toggleShowAICredits', async () => {
            const cfg = vscode.workspace.getConfiguration('antigravityPulse');
            const current = cfg.get<boolean>('showAICredits', true);
            await cfg.update('showAICredits', !current, vscode.ConfigurationTarget.Global);
            if (lastSnapshot) { updateStatusBar(lastSnapshot); }
        })
    );

    // Smart polling: pause when window is unfocused, resume on focus
    ctx.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            windowFocused = state.focused;
            const smartPolling = vscode.workspace.getConfiguration('antigravityPulse').get<boolean>('smartPolling', true);
            if (!smartPolling) { return; }

            if (state.focused) {
                // Immediate refresh + restart polling on regain focus
                refreshQuota();
                startPolling();
            } else {
                // Stop polling when user leaves Antigravity
                stopPolling();
            }
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

/** Even shorter labels for compact display mode */
const POOL_COMPACT: Record<string, string> = {
    all: 'All',
    gemini: 'Gem',
    gemini_pro: 'Pro',
    gemini_flash: 'Flash',
    claude_gpt: 'Cla',
    other: 'Other',
};

/**
 * In compact mode, when only ONE Gemini variant exists (Pro without Flash,
 * or vice versa), prefix it with "Gem" so it's not a bare "Pro" or "Flash".
 * When BOTH coexist, "Pro" and "Flash" are self-explanatory.
 */
function compactPoolLabel(poolId: string, allPoolIds: string[]): string {
    if (poolId === 'gemini_pro' || poolId === 'gemini_flash') {
        const hasBoth = allPoolIds.includes('gemini_pro') && allPoolIds.includes('gemini_flash');
        if (!hasBoth) {
            return 'Gem';
        }
    }
    return POOL_COMPACT[poolId] || poolId;
}

/** Simplify reset time to major unit only: "2h 15m" → "2h", "1d 3h" → "1d" */
function compactTime(time: string): string {
    return time.split(' ')[0];
}

function healthDot(pct: number): string {
    if (pct > 50) { return '🟢'; }
    if (pct > 20) { return '🟡'; }
    return '🔴';
}

function formatAICredits(credits: AICredit[]): string {
    if (credits.length === 0) { return ''; }
    const c = credits[0]; // Primary credit pool
    if (c.creditAmount >= 1000) {
        return `${(c.creditAmount / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return `${c.creditAmount}`;
}

function updateStatusBar(snap: QuotaSnapshot) {
    if (snap.pools.length > 0) {
        const cfg = vscode.workspace.getConfiguration('antigravityPulse');
        const showReset = cfg.get<boolean>('showResetTime', false);
        const showAICredits = cfg.get<boolean>('showAICredits', true);
        const mode = cfg.get<string>('displayMode', 'full');
        const isCompact = mode === 'compact';

        const allPoolIds = snap.pools.map(p => p.id);
        const parts: string[] = [];

        // AI credits badge (prepended)
        if (showAICredits && snap.aiCredits.length > 0) {
            const label = isCompact ? '' : 'AI ';
            parts.push(`$(sparkle) ${label}${formatAICredits(snap.aiCredits)}`);
        }

        for (const pool of snap.pools) {
            const name = isCompact
                ? compactPoolLabel(pool.id, allPoolIds)
                : (POOL_SHORT[pool.id] || pool.displayName);
            const pct = Math.round(pool.remainingPct);
            let part = `${healthDot(pool.remainingPct)} ${name} ${pct}%`;
            if (showReset && pool.timeUntilReset) {
                const time = isCompact ? compactTime(pool.timeUntilReset) : pool.timeUntilReset;
                part += ` [${time}]`;
            }
            parts.push(part);
        }

        statusBarItem.text = parts.join(' | ');
        statusBarItem.backgroundColor = undefined;

        // Rich Markdown tooltip
        statusBarItem.tooltip = buildTooltip(snap);

    } else {
        statusBarItem.text = '$(rocket) AG';
        statusBarItem.tooltip = 'Antigravity Pulse — no data yet\nClick for options';
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

    md.appendMarkdown('### Antigravity Pulse\n\n');

    // ── AI Credits section ──
    if (snap.aiCredits.length > 0) {
        for (const c of snap.aiCredits) {
            const label = c.creditType === 'GOOGLE_ONE_AI' ? 'Google AI Credits' : c.creditType;
            md.appendMarkdown(`**✦ ${label}** — ${c.creditAmount.toLocaleString()}\n\n`);
        }
        md.appendMarkdown('---\n\n');
    }

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
        md.appendMarkdown(`${bar} resets in **${pool.timeUntilReset}** _(${resetLocal})_\n\n`);

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
    md.appendMarkdown('_Click for options_');

    return md;
}

function visualBar(pct: number): string {
    const total = 15;
    const filled = Math.round((pct / 100) * total);
    const empty = total - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

// ─── Quick menu ─────────────────────────────────────────────────────

async function showQuickMenu() {
    const cfg = vscode.workspace.getConfiguration('antigravityPulse');
    const clockFormat = cfg.get<string>('clockFormat', 'auto');
    const displayMode = cfg.get<string>('displayMode', 'full');
    const showResetTime = cfg.get<boolean>('showResetTime', false);
    const showAICredits = cfg.get<boolean>('showAICredits', true);
    const smartPolling = cfg.get<boolean>('smartPolling', true);

    const items: (vscode.QuickPickItem & { action?: string })[] = [
        {
            label: '$(sync) Refresh Quota',
            description: lastSnapshot
                ? `last: ${lastSnapshot.timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                : '',
            action: 'refresh',
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        {
            label: `$(screen-full) Display: ${displayMode}`,
            description: displayMode === 'full' ? '→ compact' : '→ full',
            action: 'displayMode',
        },
        {
            label: `$(sparkle) AI Credits: ${showAICredits ? 'on' : 'off'}`,
            description: showAICredits ? '→ hide from status bar' : '→ show in status bar',
            action: 'aiCredits',
        },
        {
            label: `$(watch) Clock: ${clockFormat}`,
            description: clockFormat === 'auto' ? '→ 12h' : clockFormat === '12h' ? '→ 24h' : '→ auto',
            action: 'clockFormat',
        },
        {
            label: `$(clock) Reset Time: ${showResetTime ? 'on' : 'off'}`,
            description: showResetTime ? '→ hide' : '→ show in status bar',
            action: 'resetTime',
        },
        {
            label: `$(pulse) Smart Polling: ${smartPolling ? 'on' : 'off'}`,
            description: smartPolling ? '→ disable' : '→ enable',
            action: 'smartPolling',
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        {
            label: '$(gear) Open Pulse Settings',
            action: 'settings',
        },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Antigravity Pulse',
        placeHolder: 'Choose an action',
    });

    if (!pick?.action) { return; }

    switch (pick.action) {
        case 'refresh':
            return vscode.commands.executeCommand('antigravityPulse.refresh');
        case 'displayMode':
            return vscode.commands.executeCommand('antigravityPulse.cycleDisplayMode');
        case 'aiCredits':
            return vscode.commands.executeCommand('antigravityPulse.toggleShowAICredits');
        case 'clockFormat':
            return vscode.commands.executeCommand('antigravityPulse.toggleClockFormat');
        case 'resetTime':
            return vscode.commands.executeCommand('antigravityPulse.toggleResetTime');
        case 'smartPolling':
            return vscode.commands.executeCommand('antigravityPulse.toggleSmartPolling');
        case 'settings':
            return vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityPulse');
    }
}

// ─── States ─────────────────────────────────────────────────────────

function showLoading() {
    statusBarItem.text = '$(sync~spin) AG';
    statusBarItem.tooltip = 'Antigravity Pulse — detecting process…\nClick for options';
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
    statusBarItem.tooltip = `Antigravity Pulse — ${msg}\nClick for options`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.show();
}
