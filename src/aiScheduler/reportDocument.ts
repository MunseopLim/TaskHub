import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { AiSchedule } from './model';
import { readAiReport } from './runner';

/** Read-only documents refer only to reports explicitly opened in this session. */
export class AiReportDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly instance = randomUUID();
    private readonly jobs = new Map<string, AiSchedule>();
    constructor(private readonly storage: string) {}
    uri(job: AiSchedule): vscode.Uri {
        const uri = vscode.Uri.from({ scheme: 'taskhub-ai-report', authority: this.instance,
            path: `/${job.id}/${job.lastRun?.report ?? 'report.txt'}` });
        this.jobs.set(uri.toString(), JSON.parse(JSON.stringify(job)) as AiSchedule);
        if (this.jobs.size > 100) { this.jobs.delete(this.jobs.keys().next().value!); }
        return uri;
    }
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const job = this.jobs.get(uri.toString());
        return job ? readAiReport(this.storage, job) : '';
    }
    dispose(): void { this.jobs.clear(); }
}
