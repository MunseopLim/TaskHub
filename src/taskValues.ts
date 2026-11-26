import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Translate } from './language';
import { interpolatePipelineVariables, resolveWithinWorkspace, encodeFileContent, normalizeEol, writeWorkspaceFileSync } from './pipelineUtils';

/** 반복 결과에서 흔히 쓰는 후속 참조를 작고 예측 가능한 모양으로 합친다. */
export function aggregateForEachResults(results: readonly any[]): Record<string, any> {
    const last = results.length > 0 && results[results.length - 1]
        && typeof results[results.length - 1] === 'object'
        ? results[results.length - 1]
        : undefined;
    const aggregate: Record<string, any> = last ? { ...last } : {};
    aggregate.count = results.length;

    const collectStrings = (key: string): string[] => results.flatMap(result => {
        if (!result || typeof result !== 'object') { return []; }
        const value = result[key];
        if (typeof value === 'string') { return [value]; }
        if (Array.isArray(value)) { return value.filter((entry): entry is string => typeof entry === 'string'); }
        return [];
    });
    const outputs = collectStrings('output');
    const stderrs = collectStrings('stderr');
    const paths = results.flatMap(result => {
        if (!result || typeof result !== 'object') { return []; }
        for (const key of ['path', 'archivePath', 'outputDir']) {
            if (typeof result[key] === 'string') { return [result[key]]; }
        }
        return [];
    });
    aggregate.outputs = outputs;
    aggregate.stderrs = stderrs;
    aggregate.paths = paths;
    if (outputs.length > 0) { aggregate.output = outputs.join('\n'); }
    if (stderrs.length > 0) {
        aggregate.stderr = stderrs.join('\n');
    }
    return aggregate;
}

export function parsePathInfo(fullPath: string): { path: string, dir: string, name: string, fileNameOnly: string, fileExt: string } {
    const baseName = path.basename(fullPath);
    const extension = path.extname(baseName);
    return { path: fullPath, dir: path.dirname(fullPath), name: baseName, fileNameOnly: path.basename(baseName, extension), fileExt: extension.startsWith('.') ? extension.substring(1) : extension };
}

export function transformString(task: any, t: Translate): { output: string } {
    const { function: func, input } = task;
    if (typeof input !== 'string') { throw new Error(t(`문자열 처리 태스크 '${task.id}'의 'input' 속성은 문자열이어야 합니다.`, `String manipulation task '${task.id}' requires the 'input' property to be a string.`)); }

    const value = input;
    let output: string;
    switch (func) {
        case 'stripExtension': {
            const ext = path.extname(value);
            output = ext ? value.slice(0, -ext.length) : value;
            break;
        }
        case 'basename':
            output = path.basename(value);
            break;
        case 'basenameWithoutExtension':
            output = path.parse(value).name;
            break;
        case 'dirname':
            output = path.dirname(value);
            break;
        case 'extension': {
            const ext = path.extname(value);
            output = ext.startsWith('.') ? ext.substring(1) : ext;
            break;
        }
        case 'toLowerCase':
            output = value.toLowerCase();
            break;
        case 'toUpperCase':
            output = value.toUpperCase();
            break;
        case 'trim':
            output = value.trim();
            break;
        default:
            throw new Error(t(`지원하지 않는 문자열 처리 함수: ${func}`, `Unsupported string manipulation function: ${func}`));
    }
    return { output };
}

export function writeTaskFile(
    t: Translate,
    task: import('./schema').Task,
    interpolationContext: any,
    workspaceRoots: string[],
    defaultWorkspace: string,
    append: boolean,
    secretDerived = false
): { path: string } {
    if (typeof task.path !== 'string' || task.path.length === 0) {
        throw new Error(t(`'${task.type}' 태스크 '${task.id}'에는 비어 있지 않은 'path' 속성이 필요합니다.`, `Task '${task.id}' of type '${task.type}' requires a non-empty 'path' property.`));
    }
    if (typeof task.content !== 'string') {
        throw new Error(t(`'${task.type}' 태스크 '${task.id}'에는 문자열 'content' 속성이 필요합니다.`, `Task '${task.id}' of type '${task.type}' requires a 'content' property (string).`));
    }

    const rawPath = interpolatePipelineVariables(task.path, interpolationContext);
    const content = interpolatePipelineVariables(task.content, interpolationContext);
    const safePath = resolveWithinWorkspace(rawPath, workspaceRoots, defaultWorkspace);

    const targetExists = fs.existsSync(safePath);

    const normalized = normalizeEol(content, task.eol);
    // For appendFile on an existing file, suppress the BOM — planting a BOM
    // mid-file would corrupt the stream for UTF-8-aware readers. A fresh
    // appendFile (target absent) still gets the BOM when requested.
    const includeBom = !(append && targetExists);
    const buffer = encodeFileContent(normalized, task.encoding, includeBom);

    writeWorkspaceFileSync(safePath, workspaceRoots, defaultWorkspace, buffer, {
        append,
        overwrite: task.overwrite !== false,
        mkdirs: task.mkdirs !== false,
        mode: secretDerived ? 0o600 : undefined,
    });

    return { path: safePath };
}
