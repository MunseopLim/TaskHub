/**
 * Where a `zip`/`unzip` task reads and writes, shared by the extension and the standalone executor so
 * both pick the same archive and destination from the task and earlier results. Paths are returned as
 * written (relative paths are resolved later against the task's working directory).
 *
 * This module must not import `vscode`.
 */

/** A string result, or one of its preferred string fields (also inside an `output` object). */
export function archiveResultValue(value: unknown, preferredKeys: readonly string[]): string | undefined {
    if (!value) { return undefined; }
    if (typeof value === 'string') { return value; }
    if (typeof value !== 'object') { return undefined; }
    const record = value as Record<string, unknown>;
    for (const key of preferredKeys) {
        if (typeof record[key] === 'string') { return record[key] as string; }
    }
    if (typeof record.output === 'string') { return record.output; }
    if (record.output && typeof record.output === 'object') {
        const output = record.output as Record<string, unknown>;
        for (const key of preferredKeys) {
            if (typeof output[key] === 'string') { return output[key] as string; }
        }
    }
    return undefined;
}

/**
 * The `dir` field of the result that named the archive (a file dialog result). Unlike
 * {@link archiveResultValue} there is no fallback to the result's text: that text is the archive path
 * itself, and extracting into it would try to create a folder where the archive file is.
 */
function folderOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') { return undefined; }
    const record = value as Record<string, unknown>;
    if (typeof record.dir === 'string') { return record.dir; }
    const output = record.output;
    return output && typeof output === 'object' && typeof (output as Record<string, unknown>).dir === 'string'
        ? (output as Record<string, string>).dir : undefined;
}

interface UnzipTaskFields {
    archive?: unknown;
    destination?: unknown;
    inputs?: { archive?: string; file?: string; destination?: string };
}

/**
 * The archive comes from `archive`, else the result of `inputs.archive`/`inputs.file`. The destination
 * comes from `destination`, else the result of `inputs.destination`, else the archive result's `dir`,
 * else the archive's folder. `archive` is undefined when nothing names one.
 */
export function unzipLocations(task: UnzipTaskFields, results: Record<string, unknown>): { archive?: string; destination?: string } {
    const inputs = task.inputs ?? {};
    const own = (id: string | undefined) => id && Object.hasOwn(results, id) ? results[id] : undefined;
    const archiveSource = own(inputs.archive || inputs.file);
    const archive = (typeof task.archive === 'string' && task.archive ? task.archive : undefined)
        ?? archiveResultValue(archiveSource, ['path', 'archivePath']);
    if (!archive) { return {}; }
    const destination = (typeof task.destination === 'string' && task.destination ? task.destination : undefined)
        ?? archiveResultValue(own(inputs.destination), ['path', 'outputDir'])
        ?? folderOf(archiveSource);
    return { archive, destination };
}
