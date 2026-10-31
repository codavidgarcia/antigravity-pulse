/**
 * Quota Fetcher – Calls Antigravity's local Language Server API,
 * retrieves both the 5-hour daily rolling limit and weekly quota,
 * and groups them by quota pool (Gemini & Claude/GPT).
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
    id: string;               // e.g. "gemini", "claude_gpt"
    displayName: string;      // e.g. "Gemini", "Claude · GPT"
    remainingPct: number;     // Active 5-hour percentage (fallback to weekly)
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: string;
    
    // 5-Hour rolling limit
    fiveHourPct?: number;
    fiveHourResetTime?: Date;
    fiveHourTimeUntilReset?: string;

    // Weekly limit
    weeklyPct?: number;
    weeklyResetTime?: Date;
    weeklyTimeUntilReset?: string;

    models: ModelQuota[];
}

export interface AICredit {
    creditType: string;       // e.g. "GOOGLE_ONE_AI"
    creditAmount: number;
    minimumForUsage: number;
}

export interface QuotaSnapshot {
    credits?: PromptCredits;
    aiCredits: AICredit[];    // Google One AI credits etc.
    pools: QuotaPool[];       // Gemini and Claude/GPT pools
    models: ModelQuota[];     // flat list, all models
    timestamp: Date;
}

// ─── Server response shapes ─────────────────────────────────────────

interface QuotaBucket {
    bucketId: string;
    displayName: string;
    description?: string;
    window: string;           // '5h', 'weekly', etc.
    remainingFraction: number;
    resetTime: string;
}

interface QuotaGroup {
    displayName: string;
    description?: string;
    buckets?: QuotaBucket[];
}

interface QuotaSummaryResponse {
    response?: {
        groups?: QuotaGroup[];
        description?: string;
    };
}

interface ServerResponse {
    userStatus?: {
        planStatus?: {
            planInfo?: {
                monthlyPromptCredits?: number;
            };
            availablePromptCredits?: number;
        };
        cascadeModelConfigData?: {
            clientModelConfigs?: any[];
        };
        userTier?: {
            id?: string;
            name?: string;
            availableCredits?: {
                creditType: string;
                creditAmount: string;
                minimumCreditAmountForUsage: string;
            }[];
        };
    };
}

// ─── Family classification (label hints only) ───────────────────────

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

// ─── Fetcher ────────────────────────────────────────────────────────

export async function fetchQuota(port: number, csrfToken: string): Promise<QuotaSnapshot> {
    // Query both endpoints concurrently
    const [summaryResult, statusResult] = await Promise.allSettled([
        postWithFallback<QuotaSummaryResponse>(port, csrfToken,
            '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
            { forceRefresh: false }
        ),
        postWithFallback<ServerResponse>(port, csrfToken,
            '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            {
                metadata: {
                    ideName: 'antigravity',
                    extensionName: 'antigravity',
                    locale: 'en',
                },
            }
        ),
    ]);

    const summaryData = summaryResult.status === 'fulfilled' ? summaryResult.value : undefined;
    const statusData = statusResult.status === 'fulfilled' ? statusResult.value : undefined;

    if (!summaryData && !statusData) {
        throw new Error('Failed to fetch quota from Antigravity API');
    }

    return parseCombinedResponses(summaryData, statusData);
}

// ─── Internals ──────────────────────────────────────────────────────

async function postWithFallback<T>(port: number, csrfToken: string, path: string, body: object): Promise<T> {
    try {
        return await post<T>(port, csrfToken, path, body, 'https');
    } catch {
        return await post<T>(port, csrfToken, path, body, 'http');
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

function parseCombinedResponses(summary?: QuotaSummaryResponse, status?: ServerResponse): QuotaSnapshot {
    const userStatus = status?.userStatus;
    const planInfo = userStatus?.planStatus?.planInfo;
    const availableRaw = userStatus?.planStatus?.availablePromptCredits;

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

    // ── AI Credits (Google One, etc.) ──
    const aiCredits: AICredit[] = (userStatus?.userTier?.availableCredits || []).map(c => ({
        creditType: c.creditType,
        creditAmount: Number(c.creditAmount),
        minimumForUsage: Number(c.minimumCreditAmountForUsage),
    }));

    // ── Individual Models ──
    const rawModels: any[] = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
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

    // ── Process Quota Pools from QuotaSummary ──
    const pools: QuotaPool[] = [];
    const groups = summary?.response?.groups || [];

    if (groups.length > 0) {
        for (const group of groups) {
            const nameLower = (group.displayName || '').toLowerCase();
            const isGemini = nameLower.includes('gemini');
            const isClaude = nameLower.includes('claude') || nameLower.includes('gpt') || nameLower.includes('3p');

            const id = isGemini ? 'gemini' : isClaude ? 'claude_gpt' : nameLower.replace(/[^a-z0-9]+/g, '_');
            const displayName = isGemini ? 'Gemini' : isClaude ? 'Claude · GPT' : group.displayName;

            const buckets = group.buckets || [];
            const weeklyBucket = buckets.find(b => b.window === 'weekly' || b.bucketId.includes('weekly') || (b.displayName || '').toLowerCase().includes('weekly'));
            const fiveHourBucket = buckets.find(b => b.window === '5h' || b.bucketId.includes('5h') || (b.displayName || '').toLowerCase().includes('five hour') || (b.displayName || '').toLowerCase().includes('5-hour'));

            let weeklyPct: number | undefined;
            let weeklyResetTime: Date | undefined;
            let weeklyTimeUntilReset: string | undefined;

            if (weeklyBucket) {
                weeklyPct = Math.round((weeklyBucket.remainingFraction ?? 0) * 100);
                weeklyResetTime = new Date(weeklyBucket.resetTime);
                weeklyTimeUntilReset = formatTime(weeklyResetTime.getTime() - Date.now());
            }

            let fiveHourPct: number | undefined;
            let fiveHourResetTime: Date | undefined;
            let fiveHourTimeUntilReset: string | undefined;

            if (fiveHourBucket) {
                fiveHourPct = Math.round((fiveHourBucket.remainingFraction ?? 0) * 100);
                fiveHourResetTime = new Date(fiveHourBucket.resetTime);
                fiveHourTimeUntilReset = formatTime(fiveHourResetTime.getTime() - Date.now());
            }

            // PRIMARY DISPLAY: The daily 5-hour rolling limit (falls back to weekly if 5-hour is missing)
            const remainingPct = fiveHourPct !== undefined ? fiveHourPct : (weeklyPct ?? 100);
            const resetTime = fiveHourResetTime || weeklyResetTime || new Date();
            const timeUntilReset = fiveHourTimeUntilReset || weeklyTimeUntilReset || 'Now';
            const isExhausted = remainingPct === 0;

            // Associate relevant models to this pool
            const poolModels = models.filter(m => {
                if (isGemini) { return m.family.startsWith('gemini'); }
                if (isClaude) { return m.family === 'claude' || m.family === 'gpt'; }
                return true;
            });

            pools.push({
                id,
                displayName,
                remainingPct,
                isExhausted,
                resetTime,
                timeUntilReset,
                fiveHourPct,
                fiveHourResetTime,
                fiveHourTimeUntilReset,
                weeklyPct,
                weeklyResetTime,
                weeklyTimeUntilReset,
                models: poolModels,
            });
        }
    } else if (models.length > 0) {
        // Fallback: auto-detect pools from GetUserStatus model grouping if summary wasn't available
        const bucketMap = new Map<string, ModelQuota[]>();
        for (const m of models) {
            const key = `${m.remainingPct}|${m.resetTime.toISOString()}`;
            const list = bucketMap.get(key) || [];
            list.push(m);
            bucketMap.set(key, list);
        }

        const sortedBuckets = [...bucketMap.values()];
        for (const members of sortedBuckets) {
            const rep = members.reduce((a, b) => a.remainingPct < b.remainingPct ? a : b);
            const hasClaude = members.some(m => m.family === 'claude' || m.family === 'gpt');
            const hasGemini = members.some(m => m.family.startsWith('gemini'));
            const id = hasGemini ? 'gemini' : hasClaude ? 'claude_gpt' : 'other';
            const displayName = hasGemini ? 'Gemini' : hasClaude ? 'Claude · GPT' : 'Other';

            pools.push({
                id,
                displayName,
                remainingPct: Math.round(rep.remainingPct),
                isExhausted: rep.isExhausted,
                resetTime: rep.resetTime,
                timeUntilReset: rep.timeUntilReset,
                models: members,
            });
        }
    }

    return { credits, aiCredits, pools, models, timestamp: new Date() };
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

