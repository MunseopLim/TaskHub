export class TaskHubError extends Error {
    constructor(readonly exitCode: number, message: string) { super(message); }
}
