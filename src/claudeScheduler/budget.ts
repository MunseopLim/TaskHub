import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { constants } from 'fs';
import { t } from '../i18n';

interface Usage { id: string; at: number; budgetUsd: number; costUsd?: number; }
interface Ledger { version: 1; runs: Usage[]; }
const day = 24 * 60 * 60 * 1000;
const ledgerName = 'usage.json';

export class ClaudeBudgetLimitError extends Error {
    constructor() {
        super(t('이 폴더의 최근 24시간 실행 횟수 또는 비용 한도에 도달해 건너뛰었습니다. 예약은 유지하며 다음 예약 시각에 한도를 다시 확인합니다.',
            'Skipped because this folder reached its rolling 24-hour run or cost limit. The schedule stays enabled and checks capacity at its next scheduled time.'));
    }
}

async function readLedger(directory: string): Promise<Ledger> {
    try {
        const handle = await fs.open(path.join(directory, ledgerName), constants.O_RDONLY | constants.O_NONBLOCK);
        let text: string;
        try {
            const limit = 1024 * 1024;
            const stats = await handle.stat();
            if (!stats.isFile() || stats.size > limit) { throw new Error('invalid'); }
            const buffer = Buffer.alloc(limit + 1);
            let size = 0;
            while (size < buffer.length) {
                const read = await handle.read(buffer, size, buffer.length - size, size);
                if (!read.bytesRead) { break; }
                size += read.bytesRead;
            }
            if (size > limit) { throw new Error('invalid'); }
            text = buffer.subarray(0, size).toString('utf8');
        } finally { await handle.close(); }
        const value = JSON.parse(text) as Ledger;
        if (text.length > 1024 * 1024 || value.version !== 1 || !Array.isArray(value.runs) || value.runs.length > 1000
            || !value.runs.every(run => run && /^[a-f0-9-]{36}$/.test(run.id) && Number.isSafeInteger(run.at) && run.at >= 0
                && Number.isFinite(run.budgetUsd) && run.budgetUsd > 0
                && (run.costUsd === undefined || (Number.isFinite(run.costUsd) && run.costUsd >= 0)))) { throw new Error('invalid'); }
        return value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { version: 1, runs: [] }; }
        throw new Error(t('저장된 Claude 사용량 기록이 손상됐거나 읽을 수 없습니다. 자동 실행을 중단합니다.',
            'Stored Claude usage is corrupt or unreadable. Automatic execution is stopped.'));
    }
}

async function saveLedger(directory: string, ledger: Ledger): Promise<void> {
    const target = path.join(directory, ledgerName);
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify(ledger), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
}

/** Caller holds the workspace lease. Reserve before the paid call, including manual runs. */
export async function reserveClaudeBudget(directory: string, budgetUsd: number, maxRuns: number, maxUsd: number, now = Date.now()): Promise<string> {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000
        || !Number.isFinite(maxUsd) || maxUsd <= 0) { throw new Error(t('Claude 실행 한도를 확인하세요.', 'Check Claude execution limits.')); }
    const ledger = await readLedger(directory);
    ledger.runs = ledger.runs.filter(run => run.at > now - day);
    const spent = ledger.runs.reduce((total, run) => total + (run.costUsd ?? run.budgetUsd), 0);
    if (ledger.runs.length >= maxRuns || spent + budgetUsd > maxUsd + 1e-9) {
        throw new ClaudeBudgetLimitError();
    }
    const id = randomUUID();
    ledger.runs.push({ id, at: now, budgetUsd });
    await saveLedger(directory, ledger);
    return id;
}

/** Missing cost or interrupted runs keep their full reservation conservatively. */
export async function recordClaudeCost(directory: string, id: string, costUsd: number): Promise<void> {
    const ledger = await readLedger(directory);
    const run = ledger.runs.find(item => item.id === id);
    if (!run || !Number.isFinite(costUsd) || costUsd < 0) { throw new Error(t('Claude 비용 결과를 확인할 수 없습니다.', 'Could not validate Claude cost.')); }
    run.costUsd = costUsd;
    await saveLedger(directory, ledger);
}
