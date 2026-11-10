import * as path from 'path';

/** Windows environment names are case-insensitive, including PATH and SystemRoot. */
export function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
}

/** Match the environment passed to a child; never leave duplicate Windows keys. */
export function mergeProcessEnvironment(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
    if (platform !== 'win32') { return { ...base, ...overrides }; }
    const result: NodeJS.ProcessEnv = {};
    const names = new Map<string, string>();
    for (const source of [base, overrides]) {
        for (const [key, value] of Object.entries(source)) {
            const identity = key.toUpperCase();
            const previous = names.get(identity);
            if (previous !== undefined) { delete result[previous]; }
            names.set(identity, key);
            result[key] = value;
        }
    }
    return result;
}

function fullyQualified(file: string | undefined): file is string {
    return file !== undefined && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(file);
}

/** Resolve infrastructure shells from the host environment, never task.env or cwd. */
export function windowsPowerShellPath(hostEnv: NodeJS.ProcessEnv = process.env): string {
    const root = environmentValue(hostEnv, 'SystemRoot');
    return path.win32.join(fullyQualified(root) ? root : 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function windowsCmdPath(hostEnv: NodeJS.ProcessEnv = process.env): string {
    const comSpec = environmentValue(hostEnv, 'ComSpec');
    if (fullyQualified(comSpec)) { return path.win32.normalize(comSpec); }
    const root = environmentValue(hostEnv, 'SystemRoot');
    return path.win32.join(fullyQualified(root) ? root : 'C:\\Windows', 'System32', 'cmd.exe');
}
