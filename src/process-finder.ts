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
        const parsed = await findProcess(processNames, workspacePath);
        if (!parsed) { return null; }

        if (parsed.hubPort > 0 && await testPort(parsed.hubPort, parsed.csrfToken)) {
            return { port: parsed.hubPort, csrfToken: parsed.csrfToken };
        }

        const ports = await getListeningPorts(parsed.pid);
        if (ports.length === 0) { return null; }

        const workingPort = await findWorkingPort(ports, parsed.csrfToken);
        if (!workingPort) { return null; }

        return { port: workingPort, csrfToken: parsed.csrfToken };
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

async function findProcess(names: string[], workspacePath?: string): Promise<ParsedProcess | null> {
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

function parseProcessOutput(stdout: string, workspacePath?: string): ParsedProcess | null {
    if (process.platform === 'win32') {
        return parseWindows(stdout, workspacePath);
    }
    return parseUnix(stdout, workspacePath);
}

function parseWindows(stdout: string, workspacePath?: string): ParsedProcess | null {
    try {
        const trimmed = stdout.trim();
        if (!trimmed) { return null; }

        const raw = JSON.parse(trimmed);
        const list = Array.isArray(raw) ? raw : [raw];

        // Filter to Antigravity processes only (agy --hub or legacy language_server)
        const candidates = list.filter((d: any) => {
            const cmdLine = d?.CommandLine || '';
            const cmd = cmdLine.toLowerCase();
            const hasToken = /--csrf_token[=\s]+[a-f0-9\-]+/i.test(cmdLine);
            const isAntigravity = /--app_data_dir[=\s]+antigravity\b/i.test(cmdLine)
                || /--hub\b/i.test(cmdLine)
                || cmd.includes('\\antigravity\\')
                || cmd.includes('/antigravity/');
            return Boolean(d?.ProcessId && hasToken && isAntigravity);
        });
        if (candidates.length === 0) { return null; }

        const wsNorm = workspacePath ? workspacePath.toLowerCase() : null;
        const wsId = workspacePath ? toWorkspaceId(workspacePath).toLowerCase() : null;
        const data = (wsNorm && candidates.find((d: any) => {
            const cmd = (d.CommandLine || '').toLowerCase();
            return cmd.includes(wsNorm) || (wsId ? cmd.includes(wsId) : false);
        })) || candidates[0];

        const cmdLine = data.CommandLine || '';
        const pid = data.ProcessId;
        if (!pid) { return null; }

        const port = cmdLine.match(/--extension_server_port[=\s]+(\d+)/);
        const hubPort = cmdLine.match(/--hub-port[=\s]+(\d+)/);
        const token = cmdLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
        if (!token?.[1]) { return null; }

        return {
            pid,
            extensionPort: port ? parseInt(port[1], 10) : 0,
            hubPort: hubPort ? parseInt(hubPort[1], 10) : 0,
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
    const lines = stdout.split('\n').filter(l =>
        (l.includes('--extension_server_port') || l.includes('--hub-port') || l.includes('--hub'))
        && l.includes('--csrf_token')
    );

    // Prefer the line matching our workspace, fall back to first match
    const target = (workspacePath && lines.find(l =>
        l.includes(workspacePath) || (wsId ? l.includes(wsId) : false)
    )) || lines[0];
    if (!target) { return null; }

    const parts = target.trim().split(/\s+/);
    const pid = parseInt(parts[0], 10);
    const cmd = target.substring(parts[0].length).trim();

    const port = cmd.match(/--extension_server_port[=\s]+(\d+)/);
    const hubPort = cmd.match(/--hub-port[=\s]+(\d+)/);
    const token = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
    if (!token?.[1]) { return null; }

    return {
        pid,
        extensionPort: port ? parseInt(port[1], 10) : 0,
        hubPort: hubPort ? parseInt(hubPort[1], 10) : 0,
        csrfToken: token[1],
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
