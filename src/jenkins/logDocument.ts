import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

/** One bounded, read-only, session-only log. URIs contain no server, branch or credentials. */
export class JenkinsLogDocument implements vscode.TextDocumentContentProvider, vscode.Disposable {
    readonly uri = vscode.Uri.from({ scheme: 'taskhub-jenkins-log', path: `/${randomUUID()}/Jenkins.log` });
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changed.event;
    private content = '';
    private disposed = false;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return !this.disposed && uri.toString() === this.uri.toString() ? this.content : '';
    }

    setContent(content: string): void {
        if (this.disposed) { return; }
        if (Buffer.byteLength(content, 'utf8') > 3 * 1024 * 1024) { throw new Error('JENKINS_LOG_LIMIT'); }
        this.content = content;
        this.changed.fire(this.uri);
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.content = '';
        this.disposed = true;
        this.changed.fire(this.uri);
        this.changed.dispose();
    }
}
