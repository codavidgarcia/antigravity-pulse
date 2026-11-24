/**
 * Process Finder – Detects Antigravity's language_server process,
 * extracts the CSRF token and discovers the API port.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as process from 'process';

const execAsync = promisify(exec);

export interface ProcessInfo {
    port: number;
    csrfToken: string;
}

interface ParsedProcess {
    pid: number;
    extensionPort: number;
    csrfToken: string;
}

interface DaemonHub {
    pid: number;
    httpPort: number;
    httpsPort?: number;
    csrfToken: string;
    lsVersion?: string;
}

/**
 * Finds the running Antigravity language_server process, extracts
 * connection parameters, and discovers the correct API port.
 */
export async function findAntigravityProcess(workspacePath?: string): Promise<ProcessInfo | null> {
    // 1. Try daemon hub files (modern Antigravity / agy >= 2.34)
    try {
        const fromDaemon = await findFromDaemonFiles(workspacePath);
        if (fromDaemon) {
            return fromDaemon;
        }
    } catch {
        // Fall back to legacy CLI discovery
    }

    // 2. Legacy fallback: parse command line arguments (--csrf_token)
    const processName = getProcessName();

    try {
        const parsed = await findProcess(processName, workspacePath);
        if (!parsed) { return null; }

        let ports = await getListeningPorts(parsed.pid);
        if (parsed.extensionPort && !ports.includes(parsed.extensionPort)) {
            ports.unshift(parsed.extensionPort);
        }
        if (ports.length === 0) { return null; }

        const workingPort = await findWorkingPort(ports, parsed.csrfToken);
        if (!workingPort) { return null; }

        return { port: workingPort, csrfToken: parsed.csrfToken };
    } catch {
        return null;
    }
}

// ─── Internals ──────────────────────────────────────────────────────

function getDaemonDirs(): string[] {
    const dirs: string[] = [
        path.join(os.homedir(), '.gemini', 'antigravity', 'daemon'),
        path.join(os.homedir(), '.antigravity', 'daemon'),
    ];

    if (process.platform === 'win32') {
        if (process.env.APPDATA) {
            dirs.push(path.join(process.env.APPDATA, 'antigravity', 'daemon'));
        }
        if (process.env.USERPROFILE) {
            dirs.push(path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'daemon'));
        }
    } else {
        dirs.push(path.join(os.homedir(), '.config', 'antigravity', 'daemon'));
    }

    return dirs.filter(d => fs.existsSync(d));
}

async function findPidForWorkspace(workspacePath: string): Promise<number | null> {
    const wsId = toWorkspaceId(workspacePath);
    try {
        if (process.platform === 'win32') {
            const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${workspacePath}*' -or $_.CommandLine -like '*${wsId}*' } | Select-Object -ExpandProperty ProcessId"`;
            const { stdout } = await execAsync(cmd);
            const pid = parseInt(stdout.trim().split(/\s+/)[0], 10);
            return isNaN(pid) ? null : pid;
        } else {
            const { stdout } = await execAsync('ps -axo pid=,command=');
            const lines = stdout.split('\n');
            const target = lines.find(l => l.includes(workspacePath) || l.includes(wsId));
            if (!target) { return null; }
            const pid = parseInt(target.trim().split(/\s+/)[0], 10);
            return isNaN(pid) ? null : pid;
        }
    } catch {
        return null;
    }
}

async function findFromDaemonFiles(workspacePath?: string): Promise<ProcessInfo | null> {
    const daemonDirs = getDaemonDirs();
    if (daemonDirs.length === 0) {
        return null;
    }

    const hubs: DaemonHub[] = [];
    for (const dir of daemonDirs) {
        try {
            const files = fs.readdirSync(dir).filter(f => f.startsWith('hub_') && f.endsWith('.json'));
            for (const file of files) {
                try {
                    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
                    const data = JSON.parse(content) as DaemonHub;
                    if (data.pid && data.csrfToken && (data.httpPort || data.httpsPort)) {
                        try {
                            process.kill(data.pid, 0);
                            hubs.push(data);
                        } catch {
                            // Dead process, ignore stale hub file
                        }
                    }
                } catch {
                    // Ignore malformed files
                }
            }
        } catch {
            // Ignore unreadable dirs
        }
    }

    if (hubs.length === 0) {
        return null;
    }

    let prioritizedHubs = hubs;
    if (workspacePath && hubs.length > 1) {
        try {
            const matchedPid = await findPidForWorkspace(workspacePath);
            if (matchedPid) {
                const matched = hubs.find(h => h.pid === matchedPid);
                if (matched) {
                    prioritizedHubs = [matched, ...hubs.filter(h => h.pid !== matchedPid)];
                }
            }
        } catch {
            // Keep default ordering
        }
    }

    for (const hub of prioritizedHubs) {
        const candidatePorts: number[] = [];
        if (hub.httpPort) { candidatePorts.push(hub.httpPort); }
        if (hub.httpsPort && !candidatePorts.includes(hub.httpsPort)) { candidatePorts.push(hub.httpsPort); }

        const workingPort = await findWorkingPort(candidatePorts, hub.csrfToken);
        if (workingPort) {
            return { port: workingPort, csrfToken: hub.csrfToken };
        }
    }

    return null;
}

function getProcessName(): string {
    if (process.platform === 'win32') {
        return 'language_server_windows_x64.exe';
    }
    if (process.platform === 'darwin') {
        return `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`;
    }
    return `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`;
}

async function findProcess(name: string, workspacePath?: string): Promise<ParsedProcess | null> {
    if (process.platform === 'win32') {
        try {
            const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--csrf_token*' -or $_.CommandLine -like '*--csrf-token*' } | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
            const { stdout } = await execAsync(cmd);
            return parseWindows(stdout);
        } catch {
            return null;
        }
    }

    // Unix (macOS / Linux): check ps -axo first, which captures processes across sessions reliably
    try {
        const { stdout } = await execAsync('ps -axo pid=,command=');
        const res = parseUnix(stdout, workspacePath);
        if (res) { return res; }
    } catch { /* fallback to pgrep */ }

    try {
        const cmd = process.platform === 'darwin'
            ? `pgrep -fl ${name}`
            : `pgrep -af ${name}`;

        const { stdout } = await execAsync(cmd);
        return parseUnix(stdout, workspacePath);
    } catch {
        return null;
    }
}

function parseProcessOutput(stdout: string, workspacePath?: string): ParsedProcess | null {
    if (process.platform === 'win32') {
        return parseWindows(stdout);
    }
    return parseUnix(stdout, workspacePath);
}

function parseWindows(stdout: string): ParsedProcess | null {
    try {
        let data = JSON.parse(stdout.trim());
        if (Array.isArray(data)) {
            // Filter to Antigravity processes only
            data = data.filter((d: any) => {
                const cmd = (d.CommandLine || '').toLowerCase();
                return /--app_data_dir\s+antigravity\b/i.test(d.CommandLine || '')
                    || cmd.includes('\\antigravity\\')
                    || cmd.includes('/antigravity/')
                    || cmd.includes('agy');
            });
            if (data.length === 0) { return null; }
            data = data[0];
        }
        const cmdLine = data.CommandLine || '';
        const pid = data.ProcessId;
        if (!pid) { return null; }

        const port = cmdLine.match(/--(?:extension_server_port|hub-port|hub_port)[=\s]+(\d+)/i);
        const token = cmdLine.match(/--(?:csrf_token|csrf-token)[=\s]+([a-f0-9\-]+)/i);
        if (!token?.[1]) { return null; }

        return {
            pid,
            extensionPort: port ? parseInt(port[1], 10) : 0,
            csrfToken: token[1],
        };
    } catch {
        return null;
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

function parseUnix(stdout: string, workspacePath?: string): ParsedProcess | null {
    const wsId = workspacePath ? toWorkspaceId(workspacePath) : null;
    const lines = stdout.split('\n').filter(l => {
        const lower = l.toLowerCase();
        const hasServer = lower.includes('agy') || lower.includes('language_server');
        const hasToken = lower.includes('--csrf_token') || lower.includes('--csrf-token');
        const hasPort = lower.includes('--extension_server_port') || lower.includes('--hub-port') || lower.includes('--hub_port');
        return hasServer && hasToken && hasPort;
    });

    // Prefer the line matching our workspace, fall back to first match
    const target = (workspacePath && lines.find(l => l.includes(workspacePath))) ||
        (wsId && lines.find(l => l.includes(wsId))) ||
        lines[0];
    if (!target) { return null; }

    const parts = target.trim().split(/\s+/);
    const pid = parseInt(parts[0], 10);
    const cmd = target.substring(parts[0].length).trim();

    const port = cmd.match(/--(?:extension_server_port|hub-port|hub_port)[=\s]+(\d+)/i);
    const token = cmd.match(/--(?:csrf_token|csrf-token)[=\s]+([a-zA-Z0-9\-]+)/i);

    return {
        pid,
        extensionPort: port ? parseInt(port[1], 10) : 0,
        csrfToken: token ? token[1] : '',
    };
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
 * Try HTTP first; if it fails, fall back to HTTPS on the same port.
 */
async function testPort(port: number, csrfToken: string): Promise<boolean> {
    const ok = await testPortWithProtocol(port, csrfToken, 'http');
    if (ok) { return true; }
    return testPortWithProtocol(port, csrfToken, 'https');
}

function testPortWithProtocol(port: number, csrfToken: string, protocol: 'http' | 'https'): Promise<boolean> {
    return new Promise(resolve => {
        const payload = JSON.stringify({
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                locale: 'en',
            },
        });
        const lib = protocol === 'https' ? https : http;
        const req = lib.request(
            {
                hostname: '127.0.0.1',
                port,
                path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
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
                res.on('error', () => resolve(false));
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(false);
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf-8');
                        JSON.parse(body);
                        resolve(true);
                    } catch {
                        resolve(false);
                    }
                });
            }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(payload);
        req.end();
    });
}
