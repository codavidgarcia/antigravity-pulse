/**
 * Quota Fetcher – Calls the Antigravity GetUserStatus API,
 * parses per-model quotas, and groups them by quota pool.
 *
 * Pool detection is DYNAMIC: models are grouped by their actual
 * (remainingFraction, resetTime) pair from the API. Models that
 * share the same fraction AND resetTime are in the same pool.
 *
 * Each pool gets a display name based on a label-hint classification
 * (Gemini, Claude/GPT, etc.) but the grouping is always data-driven.
 * If Antigravity ever splits Flash into its own bucket, this code
 * will detect and display it automatically.
 */

import * as http from 'http';
import * as https from 'https';

// ─── Public types ───────────────────────────────────────────────────

export interface PromptCredits {
    available: number;
    monthly: number;
    remainingPct: number;
}

export interface ModelQuota {
    label: string;
    modelId: string;
    family: string;           // label-based hint: 'gemini', 'claude', 'gpt', 'other'
    remainingPct: number;     // 0–100
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: string;   // e.g. "2h 15m"
}

export interface QuotaPool {
    id: string;               // dynamic key, e.g. "gemini" or "gemini_flash"
    displayName: string;      // human-friendly name
    remainingPct: number;     // 0–100
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: string;
    models: ModelQuota[];
}

export interface QuotaSnapshot {
    credits?: PromptCredits;
    pools: QuotaPool[];       // auto-detected pools
    models: ModelQuota[];     // flat list, all models
    timestamp: Date;
}

// ─── Server response shape ──────────────────────────────────────────

interface ServerResponse {
    userStatus: {
        planStatus?: {
            planInfo: {
                monthlyPromptCredits: number;
            };
            availablePromptCredits: number;
        };
        cascadeModelConfigData?: {
            clientModelConfigs: any[];
        };
    };
}

// ─── Family classification (label hints only, NOT pool assignment) ──

function classifyFamily(label: string, modelId: string): string {
    const lower = (label + ' ' + modelId).toLowerCase();
    if (lower.includes('claude')) { return 'claude'; }
    if (lower.includes('gpt')) { return 'gpt'; }
    if (lower.includes('gemini')) {
        if (lower.includes('flash')) { return 'gemini_flash'; }
        return 'gemini';
    }
    return 'other';
}

// ─── Pool naming from members ───────────────────────────────────────

/** Given a pool's models, derive a short display name */
function derivePoolName(models: ModelQuota[]): { id: string; displayName: string } {
    const families = new Set(models.map(m => m.family));
    const hasPro = families.has('gemini');
    const hasFlash = families.has('gemini_flash');

    // Case 1: Both Pro and Flash share the same pool
    if (hasPro && hasFlash) {
        return { id: 'gemini', displayName: 'Gemini' };
    }
    // Case 2: Only Pro models in this pool
    if (hasPro && !hasFlash) {
        return { id: 'gemini_pro', displayName: 'Gem Pro' };
    }
    // Case 3: Only Flash models in this pool
    if (hasFlash && !hasPro) {
        return { id: 'gemini_flash', displayName: 'Gem Flash' };
    }

    // Claude + GPT together (simplified to 'Claude' per user request)
    const hasClaudeOrGpt = families.has('claude') || families.has('gpt');
    if (hasClaudeOrGpt) {
        return { id: 'claude_gpt', displayName: 'Claude' };
    }

    // Fallback: use first model's label
    return { id: 'other', displayName: models[0]?.label || 'Other' };
}

// ─── Fetcher ────────────────────────────────────────────────────────

export async function fetchQuota(port: number, csrfToken: string): Promise<QuotaSnapshot> {
    const data = await postWithFallback<ServerResponse>(port, csrfToken,
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        {
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                locale: 'en',
            },
        }
    );

    return parseResponse(data);
}

// ─── Internals ──────────────────────────────────────────────────────

/**
 * Try HTTP first; if it fails, fall back to HTTPS on the same port.
 * The language server may expose either protocol depending on version.
 */
async function postWithFallback<T>(port: number, csrfToken: string, path: string, body: object): Promise<T> {
    try {
        return await post<T>(port, csrfToken, path, body, 'http');
    } catch {
        return await post<T>(port, csrfToken, path, body, 'https');
    }
}

function post<T>(port: number, csrfToken: string, path: string, body: object, protocol: 'http' | 'https'): Promise<T> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const lib = protocol === 'https' ? https : http;
        const req = lib.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': csrfToken,
                },
                rejectUnauthorized: false,
                timeout: 5000,
            },
            res => {
                let raw = '';
                res.on('data', (chunk: Buffer) => (raw += chunk));
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try { resolve(JSON.parse(raw) as T); }
                    catch { reject(new Error('Invalid JSON from Antigravity API')); }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(payload);
        req.end();
    });
}

function parseResponse(data: ServerResponse): QuotaSnapshot {
    const userStatus = data.userStatus;
    const planInfo = userStatus.planStatus?.planInfo;
    const availableRaw = userStatus.planStatus?.availablePromptCredits;

    // ── Prompt credits ──
    let credits: PromptCredits | undefined;
    if (planInfo && availableRaw !== undefined) {
        const monthly = Number(planInfo.monthlyPromptCredits);
        const available = Number(availableRaw);
        if (monthly > 0) {
            credits = {
                available,
                monthly,
                remainingPct: (available / monthly) * 100,
            };
        }
    }

    // ── Per-model quotas ──
    const rawModels: any[] = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
    const models: ModelQuota[] = rawModels
        .filter((m: any) => m.quotaInfo)
        .map((m: any) => {
            const resetTime = new Date(m.quotaInfo.resetTime);
            const diff = resetTime.getTime() - Date.now();
            const fraction = m.quotaInfo.remainingFraction ?? 0;
            const label = m.label || 'Unknown';
            const modelId = m.modelOrAlias?.model || 'unknown';

            return {
                label,
                modelId,
                family: classifyFamily(label, modelId),
                remainingPct: fraction * 100,
                isExhausted: fraction === 0,
                resetTime,
                timeUntilReset: formatTime(diff),
            };
        });

    // ── Auto-detect pools by (fraction, resetTime) ──
    // Models with identical remainingFraction AND resetTime are in the same pool.
    const bucketMap = new Map<string, ModelQuota[]>();
    for (const m of models) {
        const key = `${m.remainingPct}|${m.resetTime.toISOString()}`;
        const list = bucketMap.get(key) || [];
        list.push(m);
        bucketMap.set(key, list);
    }

    // Convert detected buckets into QuotaPool objects
    const pools: QuotaPool[] = [];
    // Sort pools: gemini-family first, then claude/gpt, then other
    const familyOrder = ['gemini', 'gemini_flash', 'claude', 'gpt', 'other'];

    const sortedBuckets = [...bucketMap.values()].sort((a, b) => {
        const aIdx = Math.min(...a.map(m => familyOrder.indexOf(m.family)));
        const bIdx = Math.min(...b.map(m => familyOrder.indexOf(m.family)));
        return aIdx - bIdx;
    });

    for (const members of sortedBuckets) {
        const { id, displayName } = derivePoolName(members);
        const rep = members.reduce((a, b) =>
            a.remainingPct < b.remainingPct ? a : b
        );

        pools.push({
            id,
            displayName,
            remainingPct: rep.remainingPct,
            isExhausted: rep.isExhausted,
            resetTime: rep.resetTime,
            timeUntilReset: rep.timeUntilReset,
            models: members,
        });
    }

    return { credits, pools, models, timestamp: new Date() };
}

function formatTime(ms: number): string {
    if (ms <= 0) { return 'Now'; }
    const mins = Math.ceil(ms / 60_000);
    if (mins < 60) { return `${mins}m`; }
    const h = Math.floor(mins / 60);
    if (h >= 24) {
        const d = Math.floor(h / 24);
        const remH = h % 24;
        return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
    }
    return `${h}h ${mins % 60}m`;
}
