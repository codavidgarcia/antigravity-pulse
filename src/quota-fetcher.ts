/**
 * Quota Fetcher – Calls the Antigravity GetUserStatus API,
 * parses per-model quotas, and groups them by quota pool.
 *
 * Quota Pool Rules (from Antigravity's actual grouping):
 *   • Gemini 3.x models  → "Gemini 3.x" pool
 *   • Claude + GPT models → "Claude / GPT" pool
 *   • Gemini 2.5 models  → "Gemini 2.5" pool
 *   • Others             → "Other" pool
 *
 * Models sharing the same pool have identical remainingFraction
 * and resetTime in the API response.
 */

import * as https from 'https';

// ─── Public types ───────────────────────────────────────────────────

export type QuotaPoolId = 'gemini3' | 'claude_gpt' | 'gemini2.5' | 'other';

export interface PromptCredits {
    available: number;
    monthly: number;
    remainingPct: number;
}

export interface ModelQuota {
    label: string;
    modelId: string;
    pool: QuotaPoolId;
    remainingPct: number;   // 0–100
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: string; // e.g. "2h 15m"
}

export interface QuotaPool {
    id: QuotaPoolId;
    displayName: string;
    remainingPct: number;   // 0–100  (from the first model in the pool)
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: string;
    models: ModelQuota[];   // individual models in this pool
}

export interface QuotaSnapshot {
    credits?: PromptCredits;
    pools: QuotaPool[];     // grouped by quota pool
    models: ModelQuota[];   // flat list, all models
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

// ─── Pool classification ────────────────────────────────────────────

const POOL_DISPLAY_NAMES: Record<QuotaPoolId, string> = {
    gemini3: 'Gemini 3.x',
    'claude_gpt': 'Claude / GPT',
    'gemini2.5': 'Gemini 2.5',
    other: 'Other',
};

function classifyModel(label: string, modelId: string): QuotaPoolId {
    const lower = (label + ' ' + modelId).toLowerCase();

    // Claude and GPT share one pool
    if (lower.includes('claude') || lower.includes('gpt')) {
        return 'claude_gpt';
    }

    // Gemini: distinguish 3.x vs 2.5
    if (lower.includes('gemini')) {
        if (/gemini[- _]?3(\.\d+)?/i.test(lower)) {
            return 'gemini3';
        }
        if (/gemini[- _]?2[.-]?5/i.test(lower)) {
            return 'gemini2.5';
        }
    }

    return 'other';
}

// ─── Fetcher ────────────────────────────────────────────────────────

export async function fetchQuota(port: number, csrfToken: string): Promise<QuotaSnapshot> {
    const data = await post<ServerResponse>(port, csrfToken,
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

function post<T>(port: number, csrfToken: string, path: string, body: object): Promise<T> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request(
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
                pool: classifyModel(label, modelId),
                remainingPct: fraction * 100,
                isExhausted: fraction === 0,
                resetTime,
                timeUntilReset: formatTime(diff),
            };
        });

    // ── Group into pools ──
    const poolMap = new Map<QuotaPoolId, ModelQuota[]>();
    for (const m of models) {
        const list = poolMap.get(m.pool) || [];
        list.push(m);
        poolMap.set(m.pool, list);
    }

    // Canonical pool order
    const poolOrder: QuotaPoolId[] = ['gemini3', 'claude_gpt', 'gemini2.5', 'other'];
    const pools: QuotaPool[] = poolOrder
        .filter(id => poolMap.has(id))
        .map(id => {
            const members = poolMap.get(id)!;
            // All members within the same pool share the same fraction/reset
            // Use the minimum remaining % as the representative value
            const lowestModel = members.reduce((a, b) =>
                a.remainingPct < b.remainingPct ? a : b
            );

            return {
                id,
                displayName: POOL_DISPLAY_NAMES[id],
                remainingPct: lowestModel.remainingPct,
                isExhausted: lowestModel.isExhausted,
                resetTime: lowestModel.resetTime,
                timeUntilReset: lowestModel.timeUntilReset,
                models: members,
            };
        });

    return { credits, pools, models, timestamp: new Date() };
}

function formatTime(ms: number): string {
    if (ms <= 0) { return 'Now'; }
    const mins = Math.ceil(ms / 60_000);
    if (mins < 60) { return `${mins}m`; }
    const h = Math.floor(mins / 60);
    return `${h}h ${mins % 60}m`;
}
