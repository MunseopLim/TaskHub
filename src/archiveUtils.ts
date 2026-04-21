import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

/**
 * Create a zip archive at `archivePath` containing the given sources. Each
 * source may be a file or a directory; directories are added recursively under
 * their basename. Returns after the archive is flushed to disk.
 */
export async function createZipArchive(archivePath: string, sources: string[]): Promise<void> {
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new Error('createZipArchive requires at least one source path.');
    }

    const zip = new AdmZip();
    for (const source of sources) {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(source);
        } catch (e: any) {
            throw new Error(`Source path not found: ${source}`);
        }

        if (stat.isDirectory()) {
            // Preserve the directory name as the top-level folder inside the archive.
            zip.addLocalFolder(source, path.basename(source));
        } else if (stat.isFile()) {
            zip.addLocalFile(source);
        } else {
            throw new Error(`Unsupported source type (not a file or directory): ${source}`);
        }
    }

    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        zip.writeZip(archivePath, (err) => {
            if (err) { reject(err); } else { resolve(); }
        });
    });
}

/**
 * Extract a zip archive to `destination`. Each entry path is validated to
 * remain inside `destination` — entries that would escape (path traversal,
 * a.k.a. "zip slip") cause the extraction to abort before writing anything.
 */
export async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }

    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries();
    const resolvedDest = path.resolve(destination);

    // Validate every entry first so we don't leave a half-extracted archive on
    // disk if a malicious entry appears midway through.
    for (const entry of entries) {
        const targetPath = path.resolve(resolvedDest, entry.entryName);
        const relative = path.relative(resolvedDest, targetPath);
        if (relative === '' && !entry.isDirectory) {
            // Entry resolves exactly to destination — only allowed for directories.
            throw new Error(`Invalid archive entry resolves to destination root: ${entry.entryName}`);
        }
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Blocked path traversal in archive: ${entry.entryName}`);
        }
    }

    fs.mkdirSync(resolvedDest, { recursive: true });
    for (const entry of entries) {
        const targetPath = path.resolve(resolvedDest, entry.entryName);
        if (entry.isDirectory) {
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, entry.getData());
        }
    }
}
