/**
 * Process Finder – Detects Antigravity's server process (agy --hub or legacy language_server),
 * extracts the CSRF token and discovers the API port.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as https from 'https';
import * as process from 'process';

const execAsync = promisify(exec);

export interface ProcessInfo {
    port: number;
    csrfToken: string;
}

interface ParsedProcess {
    pid: number;
    extensionPort: number;
    hubPort: number;
    csrfToken: string;
}

/**
 * Finds the running Antigravity language_server or agy --hub process, extracts
 * connection parameters, and discovers the correct API port.
 */
export async function findAntigravityProcess(
    workspacePath?: string,
    extensionHint?: Partial<ProcessInfo>
): Promise<ProcessInfo | null> {
    if (extensionHint?.port && extensionHint?.csrfToken) {
        if (await testPort(extensionHint.port, extensionHint.csrfToken)) {
            return { port: extensionHint.port, csrfToken: extensionHint.csrfToken };
        }
    }

    const processNames = getProcessNames();

    try {
        const candidates = await findProcesses(processNames, workspacePath);
        for (const parsed of candidates) {
            if (parsed.hubPort > 0 && await testPort(parsed.hubPort, parsed.csrfToken)) {
                return { port: parsed.hubPort, csrfToken: parsed.csrfToken };
            }
            if (parsed.extensionPort > 0 && parsed.extensionPort !== parsed.hubPort && await testPort(parsed.extensionPort, parsed.csrfToken)) {
                return { port: parsed.extensionPort, csrfToken: parsed.csrfToken };
            }

            const ports = await getListeningPorts(parsed.pid);
            if (ports.length === 0) { continue; }

            const workingPort = await findWorkingPort(ports, parsed.csrfToken);
            if (workingPort) {
                return { port: workingPort, csrfToken: parsed.csrfToken };
            }
        }
        return null;
    } catch {
        return null;
    }
}

// ─── Internals ──────────────────────────────────────────────────────

function getProcessNames(): string[] {
    if (process.platform === 'win32') {
        return ['agy.exe', 'language_server_windows_x64.exe'];
    }
    if (process.platform === 'darwin') {
        return ['agy', `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`];
    }
    return ['agy', `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`];
}

async function findProcesses(names: string[], workspacePath?: string): Promise<ParsedProcess[]> {
    const filter = names.map(n => `name='${n}'`).join(' OR ');
    const pattern = names.join('|');
    const cmd = process.platform === 'win32'
        ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"${filter}\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`
        : process.platform === 'darwin'
            ? `pgrep -fl "${pattern}"`
            : `pgrep -af "${pattern}"`;

    const { stdout } = await execAsync(cmd);
    return parseProcessOutput(stdout, workspacePath);
}

function parseProcessOutput(stdout: string, workspacePath?: string): ParsedProcess[] {
    if (process.platform === 'win32') {
        return parseWindows(stdout, workspacePath);
    }
    return parseUnix(stdout, workspacePath);
}

function parseWindows(stdout: string, workspacePath?: string): ParsedProcess[] {
    try {
        const trimmed = stdout.trim();
        if (!trimmed) { return []; }

        const raw = JSON.parse(trimmed);
        const list = Array.isArray(raw) ? raw : [raw];

        // Filter to Antigravity processes only (agy --hub or legacy language_server)
        const candidates = list.filter((d: any) => {
            const cmdLine = d?.CommandLine || '';
            const cmd = cmdLine.toLowerCase();
            const hasToken = /--csrf_token[=\s]+[a-f0-9\-]+/i.test(cmdLine);
            const isAntigravity = /--app_data_dir[=\s]+antigravity(?:-ide)?\b/i.test(cmdLine)
                || /--hub\b/i.test(cmdLine)
                || cmd.includes('\\antigravity\\')
                || cmd.includes('/antigravity/')
                || cmd.includes('antigravity-ide');
            return Boolean(d?.ProcessId && hasToken && isAntigravity);
        });
        if (candidates.length === 0) { return []; }

        const wsNorm = workspacePath ? workspacePath.toLowerCase() : null;
        const wsId = workspacePath ? toWorkspaceId(workspacePath).toLowerCase() : null;
        const prioritized = [...candidates].sort((a: any, b: any) => {
            const aCmd = (a.CommandLine || '').toLowerCase();
            const bCmd = (b.CommandLine || '').toLowerCase();
            const aMatch = wsNorm ? (aCmd.includes(wsNorm) || (wsId ? aCmd.includes(wsId) : false)) : false;
            const bMatch = wsNorm ? (bCmd.includes(wsNorm) || (wsId ? bCmd.includes(wsId) : false)) : false;
            return Number(bMatch) - Number(aMatch);
        });

        const parsedList: ParsedProcess[] = [];
        for (const data of prioritized) {
            const cmdLine = data.CommandLine || '';
            const pid = data.ProcessId;
            if (!pid) { continue; }

            const port = cmdLine.match(/--extension_server_port[=\s]+(\d+)/);
            const hubPort = cmdLine.match(/--hub[-_]port[=\s]+(\d+)/);
            const token = cmdLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
            if (!token?.[1]) { continue; }

            parsedList.push({
                pid,
                extensionPort: port ? parseInt(port[1], 10) : 0,
                hubPort: hubPort ? parseInt(hubPort[1], 10) : 0,
                csrfToken: token[1],
            });
        }
        return parsedList;
    } catch {
        return [];
    }
}

/**
 * Converts a workspace folder path to the workspace_id format
 * used by the language server's --workspace_id argument.
 * e.g. "/Users/me/My Project" → "file_Users_me_My_20Project"
 */
function toWorkspaceId(folderPath: string): string {
    return 'file' + folderPath.replace(/ /g, '_20').replace(/\//g, '_');
}

function parseUnix(stdout: string, workspacePath?: string): ParsedProcess[] {
    const wsId = workspacePath ? toWorkspaceId(workspacePath) : null;
    const lines = stdout.split('\n').filter(l =>
        (l.includes('--extension_server_port') || l.includes('--hub-port') || l.includes('--hub'))
        && l.includes('--csrf_token')
    );
    if (lines.length === 0) { return []; }

    const prioritized = [...lines].sort((a, b) => {
        const aMatch = workspacePath ? (a.includes(workspacePath) || (wsId ? a.includes(wsId) : false)) : false;
        const bMatch = workspacePath ? (b.includes(workspacePath) || (wsId ? b.includes(wsId) : false)) : false;
        return Number(bMatch) - Number(aMatch);
    });

    const parsedList: ParsedProcess[] = [];
    for (const target of prioritized) {
        const parts = target.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        if (isNaN(pid)) { continue; }
        const cmd = target.substring(parts[0].length).trim();

        const port = cmd.match(/--extension_server_port[=\s]+(\d+)/);
        const hubPort = cmd.match(/--hub[-_]port[=\s]+(\d+)/);
        const token = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
        if (!token?.[1]) { continue; }

        parsedList.push({
            pid,
            extensionPort: port ? parseInt(port[1], 10) : 0,
            hubPort: hubPort ? parseInt(hubPort[1], 10) : 0,
            csrfToken: token[1],
        });
    }
    return parsedList;
}

async function getListeningPorts(pid: number): Promise<number[]> {
    try {
        const cmd = process.platform === 'darwin'
            ? `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`
            : process.platform === 'win32'
                ? `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`
                : `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;

        const { stdout } = await execAsync(cmd);
        return parsePortOutput(stdout, pid);
    } catch {
        return [];
    }
}

function parsePortOutput(stdout: string, pid: number): number[] {
    const ports: number[] = [];

    if (process.platform === 'win32') {
        try {
            const data = JSON.parse(stdout.trim());
            const arr = Array.isArray(data) ? data : [data];
            for (const p of arr) {
                if (typeof p === 'number' && !ports.includes(p)) { ports.push(p); }
            }
        } catch { /* ignore */ }
        return ports.sort((a, b) => a - b);
    }

    // macOS / Linux – parse lsof output
    const lsofRegex = new RegExp(
        `^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`,
        'gim'
    );
    let match;
    while ((match = lsofRegex.exec(stdout)) !== null) {
        const p = parseInt(match[1], 10);
        if (!ports.includes(p)) { ports.push(p); }
    }

    // Linux – parse ss output
    // Format: LISTEN  0  128  *:42100  *:*  users:(("language_server",pid=1234,fd=5))
    for (const line of stdout.split('\n')) {
        if (!line.includes(`pid=${pid}`)) { continue; }
        const cols = line.trim().split(/\s+/);
        // ss columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port Process
        const localAddr = cols[3];
        if (!localAddr) { continue; }
        const portMatch = localAddr.match(/:(\d+)$/);
        if (portMatch) {
            const p = parseInt(portMatch[1], 10);
            if (!ports.includes(p)) { ports.push(p); }
        }
    }

    return ports.sort((a, b) => a - b);
}

async function findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
    for (const port of ports) {
        const ok = await testPort(port, csrfToken);
        if (ok) { return port; }
    }
    return null;
}

/**
 * Try GetUserStatus (agy --hub / 2.6.0+) first, then GetUnleashData (legacy 1.x),
 * falling back from HTTP to HTTPS for each endpoint.
 */
async function testPort(port: number, csrfToken: string): Promise<boolean> {
    const probes: Array<{ protocol: 'http' | 'https'; path: string; body: object }> = [
        {
            protocol: 'http',
            path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            body: { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } },
        },
        {
            protocol: 'https',
            path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            body: { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } },
        },
        {
            protocol: 'http',
            path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            body: { wrapper_data: {} },
        },
        {
            protocol: 'https',
            path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            body: { wrapper_data: {} },
        },
    ];

    for (const probe of probes) {
        if (await testPortWithProtocol(port, csrfToken, probe.protocol, probe.path, probe.body)) {
            return true;
        }
    }
    return false;
}

function testPortWithProtocol(
    port: number,
    csrfToken: string,
    protocol: 'http' | 'https',
    path: string,
    bodyObj: object
): Promise<boolean> {
    return new Promise(resolve => {
        const lib = protocol === 'https' ? https : http;
        const payload = JSON.stringify(bodyObj);
        const req = lib.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'X-Codeium-Csrf-Token': csrfToken,
                    'Connect-Protocol-Version': '1',
                },
                rejectUnauthorized: false,
                timeout: 3000,
            },
            res => {
                let body = '';
                res.on('data', (chunk: Buffer) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { JSON.parse(body); resolve(true); } catch { resolve(false); }
                    } else { resolve(false); }
                });
            }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(payload);
        req.end();
    });
}
