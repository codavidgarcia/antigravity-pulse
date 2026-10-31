/**
 * Process Finder – Detects Antigravity's language_server process,
 * extracts the CSRF token and discovers the API port.
 *
 * Supports both log-based discovery (fast & reliable on Windows/Mac/Linux)
 * and active process inspection as a fallback.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as https from 'https';
import * as process from 'process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

/**
 * Finds the running Antigravity language_server process, extracts
 * connection parameters, and discovers the correct API port.
 */
export async function findAntigravityProcess(workspacePath?: string): Promise<ProcessInfo | null> {
    // 1. Try instant log-based discovery first (most reliable on Windows & Unix)
    const logInfo = await findFromLogs();
    if (logInfo) {
        const workingPort = await findWorkingPort([logInfo.port], logInfo.csrfToken);
        if (workingPort) {
            return { port: workingPort, csrfToken: logInfo.csrfToken };
        }
    }

    // 2. Fallback to process table scanning
    const processName = getProcessName();

    try {
        const parsed = await findProcess(processName, workspacePath);
        if (!parsed) { return null; }

        const ports = await getListeningPorts(parsed.pid);
        if (ports.length === 0 && parsed.extensionPort > 0) {
            ports.push(parsed.extensionPort);
        }
        if (ports.length === 0) { return null; }

        const workingPort = await findWorkingPort(ports, parsed.csrfToken);
        if (!workingPort) { return null; }

        return { port: workingPort, csrfToken: parsed.csrfToken };
    } catch {
        return null;
    }
}

// ─── Log-Based Discovery ─────────────────────────────────────────────

function getCandidateLogDirs(): string[] {
    const home = os.homedir();
    const platform = process.platform;
    const dirs: string[] = [];

    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        dirs.push(path.join(appData, 'Antigravity IDE', 'logs'));
        dirs.push(path.join(home, '.gemini', 'antigravity-ide', 'logs'));
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        dirs.push(path.join(localAppData, 'Programs', 'Antigravity IDE', 'logs'));
    } else if (platform === 'darwin') {
        dirs.push(path.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'logs'));
        dirs.push(path.join(home, '.gemini', 'antigravity-ide', 'logs'));
    } else {
        const configDir = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        dirs.push(path.join(configDir, 'Antigravity IDE', 'logs'));
        dirs.push(path.join(home, '.gemini', 'antigravity-ide', 'logs'));
    }

    return dirs.filter(d => fs.existsSync(d));
}

async function findFromLogs(): Promise<ProcessInfo | null> {
    const candidateDirs = getCandidateLogDirs();
    if (candidateDirs.length === 0) {
        return null;
    }

    let newestFile: string | null = null;
    let newestMtime = 0;

    for (const logsDir of candidateDirs) {
        try {
            const subdirs = fs.readdirSync(logsDir);
            for (const d of subdirs) {
                const candidate = path.join(logsDir, d, 'ls-main.log');
                if (fs.existsSync(candidate)) {
                    const stat = fs.statSync(candidate);
                    if (stat.mtimeMs > newestMtime) {
                        newestMtime = stat.mtimeMs;
                        newestFile = candidate;
                    }
                }
            }
        } catch {
            continue;
        }
    }

    if (!newestFile) {
        return null;
    }

    try {
        let fd: number | null = null;
        const maxBytes = 64 * 1024;
        let content = '';
        try {
            fd = fs.openSync(newestFile, 'r');
            const buffer = Buffer.alloc(maxBytes);
            const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
            content = buffer.toString('utf8', 0, bytesRead);
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* ignore */ }
            }
        }

        const csrfMatch = content.match(/--csrf_token\s+([a-f0-9-]+)/i);
        const portMatch = content.match(/LS started on port\s+(\d+)/i) ||
                          content.match(/listening on random port at\s+(\d+)\s+for HTTPS/i);

        if (csrfMatch && portMatch) {
            return {
                csrfToken: csrfMatch[1],
                port: parseInt(portMatch[1], 10),
            };
        }
    } catch {
        return null;
    }

    return null;
}

// ─── Process Scanner ─────────────────────────────────────────────────

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
        // Safe base64 encoded command to avoid cmd.exe quote stripping
        const psScript = `Get-CimInstance Win32_Process -Filter "name='${name}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
        const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
        const cmd = `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
        const { stdout } = await execAsync(cmd);
        return parseWindows(stdout);
    }

    const cmd = process.platform === 'darwin'
        ? `pgrep -fl ${name}`
        : `pgrep -af ${name}`;

    const { stdout } = await execAsync(cmd);
    return parseUnix(stdout, workspacePath);
}

function parseWindows(stdout: string): ParsedProcess | null {
    try {
        let data = JSON.parse(stdout.trim());
        if (Array.isArray(data)) {
            // Filter to Antigravity processes only
            const filtered = data.filter((d: any) => {
                const cmd = (d.CommandLine || '').toLowerCase();
                return /--app_data_dir\s+antigravity/i.test(d.CommandLine || '')
                    || cmd.includes('antigravity')
                    || cmd.includes('language_server');
            });
            if (filtered.length === 0) { return null; }
            data = filtered;
        } else {
            data = [data];
        }

        for (const item of data) {
            const cmdLine = item.CommandLine || '';
            const pid = item.ProcessId;
            if (!pid) { continue; }

            const port = cmdLine.match(/--extension_server_port[=\s]+(\d+)/);
            const token = cmdLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
            if (!token?.[1]) { continue; }

            return {
                pid,
                extensionPort: port ? parseInt(port[1], 10) : 0,
                csrfToken: token[1],
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Converts a workspace folder path to the workspace_id format
 * used by the language server's --workspace_id argument.
 */
function toWorkspaceId(folderPath: string): string {
    return 'file' + folderPath.replace(/ /g, '_20').replace(/\//g, '_');
}

function parseUnix(stdout: string, workspacePath?: string): ParsedProcess | null {
    const wsId = workspacePath ? toWorkspaceId(workspacePath) : null;
    const lines = stdout.split('\n').filter(l => l.includes('--extension_server_port'));

    // Prefer the line matching our workspace, fall back to first match
    const target = (wsId && lines.find(l => l.includes(wsId))) || lines[0];
    if (!target) { return null; }

    const parts = target.trim().split(/\s+/);
    const pid = parseInt(parts[0], 10);
    const cmd = target.substring(parts[0].length).trim();

    const port = cmd.match(/--extension_server_port[=\s]+(\d+)/);
    const token = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);

    return {
        pid,
        extensionPort: port ? parseInt(port[1], 10) : 0,
        csrfToken: token ? token[1] : '',
    };
}

async function getListeningPorts(pid: number): Promise<number[]> {
    try {
        if (process.platform === 'win32') {
            const psScript = `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`;
            const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
            const cmd = `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
            const { stdout } = await execAsync(cmd);
            return parsePortOutput(stdout, pid);
        }

        const cmd = process.platform === 'darwin'
            ? `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`
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
            const trimmed = stdout.trim();
            if (!trimmed) { return []; }
            const data = JSON.parse(trimmed);
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
    for (const line of stdout.split('\n')) {
        if (!line.includes(`pid=${pid}`)) { continue; }
        const cols = line.trim().split(/\s+/);
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
 * Try HTTPS first (as Antigravity uses HTTPS), then fall back to HTTP.
 */
async function testPort(port: number, csrfToken: string): Promise<boolean> {
    const okHttps = await testPortWithProtocol(port, csrfToken, 'https');
    if (okHttps) { return true; }
    return testPortWithProtocol(port, csrfToken, 'http');
}

function testPortWithProtocol(port: number, csrfToken: string, protocol: 'http' | 'https'): Promise<boolean> {
    return new Promise(resolve => {
        const lib = protocol === 'https' ? https : http;
        const req = lib.request(
            {
                hostname: '127.0.0.1',
                port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
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
        req.write(JSON.stringify({ wrapper_data: {} }));
        req.end();
    });
}

