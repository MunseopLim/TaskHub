/** Compatible with older VS Code extension hosts: no AbortSignal.any/timeout dependency. */
export function createJenkinsScope(parents: Array<AbortSignal | undefined> = [], timeoutMs?: number): {
    signal: AbortSignal; abort(): void; dispose(): void;
} {
    const controller = new AbortController();
    const cleanup: Array<() => void> = [];
    const abort = (): void => controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const parent of parents) {
        if (!parent) { continue; }
        parent.addEventListener('abort', abort, { once: true });
        cleanup.push(() => parent.removeEventListener('abort', abort));
        if (parent.aborted) { abort(); }
    }
    if (timeoutMs !== undefined) { timer = setTimeout(abort, timeoutMs); }
    return {
        signal: controller.signal, abort,
        dispose(): void { clearTimeout(timer); cleanup.forEach(remove => remove()); cleanup.length = 0; abort(); },
    };
}
