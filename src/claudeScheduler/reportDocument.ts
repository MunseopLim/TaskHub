import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ClaudeSchedule } from './model';
import { readClaudeReport } from './runner';

/** Read-only documents refer only to reports explicitly opened in this session. */
export class ClaudeReportDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly instance = randomUUID();
    private readonly jobs = new Map<string, ClaudeSchedule>();
    constructor(private readonly storage: string) {}
    uri(job: ClaudeSchedule): vscode.Uri {
        const uri = vscode.Uri.from({ scheme: 'taskhub-claude-report', authority: this.instance,
            path: `/${job.id}/${job.lastRun?.report ?? 'report.txt'}` });
        this.jobs.set(uri.toString(), JSON.parse(JSON.stringify(job)) as ClaudeSchedule);
        if (this.jobs.size > 100) { this.jobs.delete(this.jobs.keys().next().value!); }
        return uri;
    }
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const job = this.jobs.get(uri.toString());
        return job ? readClaudeReport(this.storage, job) : '';
    }
    dispose(): void { this.jobs.clear(); }
}
