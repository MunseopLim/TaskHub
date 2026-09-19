export const jenkinsLimits = {
    maxServers: 32, maxActiveRequests: 20, maxRunsPerRequest: 1001, maxRetainedRuns: 2000,
    requestDeadlineMs: 30000, maxCandidates: 2000, maxStoredBytes: 8 * 1024 * 1024,
} as const;

export interface JenkinsServer {
    id: string;
    name: string;
    url: string;
    username: string;
    caFile?: string;
    allowInsecureHttp?: boolean;
}

export interface JenkinsParameter {
    name: string;
    type: string;
    description?: string;
    defaultValue?: unknown;
    choices?: string[];
}

export interface JenkinsJob {
    name: string;
    fullName: string;
    url: string;
    buildable: boolean;
    kind: string;
    parameters?: JenkinsParameter[];
}

export interface JenkinsCause {
    upstreamUrl?: string;
    upstreamProject?: string;
    upstreamBuild?: number;
    upstreamCauses?: JenkinsCause[];
}

export interface JenkinsAction {
    _class?: string;
    causes?: JenkinsCause[];
    parameters?: Array<{ name: string; value: unknown }>;
    lastBuiltRevision?: { SHA1?: string };
    remoteUrls?: string[];
    [key: string]: unknown;
}

export interface JenkinsBuild {
    url: string;
    number: number;
    fullDisplayName?: string;
    building: boolean;
    result: string | null;
    timestamp?: number;
    duration?: number;
    queueId?: number;
    actions?: JenkinsAction[];
    artifacts?: Array<{ fileName: string; relativePath: string }>;
}

export interface JenkinsQueue {
    id?: number;
    why?: string;
    cancelled?: boolean;
    executable?: { url: string; number: number };
}

export interface JenkinsStage {
    id: string;
    name: string;
    status: string;
    durationMillis?: number;
}

export interface JenkinsStages {
    detailsTruncated?: boolean;
    status?: string;
    stages?: JenkinsStage[];
}

export interface JenkinsTestCase {
    name: string;
    className?: string;
    status: string;
    errorDetails?: string;
}

export interface JenkinsTestReport {
    detailsTruncated?: boolean;
    passCount: number;
    failCount: number;
    skipCount: number;
    suites?: Array<{ name?: string; cases?: JenkinsTestCase[] }>;
}

export interface TrackedJenkinsBuild extends JenkinsBuild {
    serverId: string;
    jobUrl: string;
    correlation?: 'root' | 'upstream' | 'requestId' | 'manifest';
    actualSha?: string;
    error?: string;
    reportErrors?: { stages?: string; tests?: string };
    stages?: JenkinsStages | null;
    tests?: JenkinsTestReport | null;
}

export interface JenkinsRequest {
    id: string;
    createdAt: number;
    branch: string;
    remoteBranch?: string;
    sha: string;
    repoPath: string;
    repoRemote?: string;
    root: { serverId: string; jobUrl: string; queueUrl?: string; buildUrl?: string };
    runs: TrackedJenkinsBuild[];
    discovery: { complete: boolean; message?: string; checkedAt?: number };
    requestIdParameter?: string;
    shaParameter?: string;
    submission?: 'sending' | 'unconfirmed';
    queueReason?: string;
    error?: string;
    stopped?: boolean;
    settledAt?: number;
    notified: Record<string, boolean>;
}

export interface JenkinsJobProfile {
    serverId: string;
    jobUrl: string;
    branchParameter?: string;
    shaParameter?: string;
    requestIdParameter?: string;
}
