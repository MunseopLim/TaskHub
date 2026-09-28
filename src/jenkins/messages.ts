import { t } from '../i18n';
import { JenkinsClientError, normalizeJenkinsServerUrl } from './client';

/** Only known codes are translated; never display an arbitrary exception or response body. */
export function jenkinsErrorLabel(code?: string): string {
    if (code?.startsWith('JENKINS_SUBMISSION_UNCONFIRMED')) {
        return t('전송 결과를 확인하지 못했습니다. Jenkins 대기열을 확인해주세요. 자동 재전송하지 않습니다.', 'Submission could not be confirmed. Check the Jenkins queue; it will not be resubmitted automatically.');
    }
    const labels: Record<string, string> = {
        AUTH_REQUIRED: t('인증이 필요합니다. 사용자 이름과 API 토큰을 확인해주세요.', 'Authentication required. Check the username and API token.'),
        INVALID_CREDENTIALS: t('사용자 이름 또는 API 토큰이 없거나 유효하지 않습니다.', 'The username or API token is missing or invalid.'),
        FORBIDDEN: t('서버가 접근을 거부했습니다. 계정 인증·권한 또는 프록시/SSO 정책을 확인해주세요.', 'Access denied. Check account authentication, permissions, or proxy/SSO policy.'),
        REDIRECT: t('로그인 페이지 또는 다른 주소로 이동하는 연결입니다. SSO 페이지 대신 직접 접근할 Jenkins API 주소를 설정해주세요.', 'The server redirects to a login page or another URL. Configure a direct Jenkins API URL instead of the SSO page.'),
        BACKOFF: t('서버 오류 후 재시도를 잠시 기다리고 있습니다.', 'Waiting before retrying after a server error.'),
        PERMISSION_LIMIT: t('권한 오류 추적 한도에 도달해 이 서버의 조회를 잠시 중지했습니다. 계정 권한을 확인해주세요.', 'The permission-error tracking limit was reached. Queries to this server are briefly paused; check account permissions.'),
        BUSY: t('조회 대기열이 가득 찼습니다. 잠시 후 다시 시도해주세요.', 'The request queue is full. Try again shortly.'),
        TIMEOUT: t('서버 응답 시간이 초과되었습니다. 연결 상태를 확인해주세요.', 'The server response timed out. Check connectivity.'),
        JENKINS_SUBMISSION_PREPARATION_TIMEOUT: t('빌드 요청을 준비하는 동안 제한 시간을 초과했습니다. 서버 설정과 인증 정보를 확인해주세요.', 'Build submission preparation timed out. Check the server configuration and credentials.'),
        NETWORK_ERROR: t('서버에 연결하지 못했습니다. VPN·네트워크·인증서 설정을 확인해주세요.', 'Cannot connect to the server. Check VPN, network and certificate settings.'),
        INVALID_CA: t('CA 인증서를 읽거나 검증하지 못했습니다. PEM 파일을 확인해주세요.', 'Cannot read or validate the CA certificate. Check the PEM file.'),
        INSECURE_HTTP: t('HTTP 연결이 차단되었습니다. HTTPS를 사용하거나 서버 설정에서 평문 전송을 명시적으로 허용해주세요.', 'HTTP is blocked. Use HTTPS or explicitly allow unencrypted transport in server settings.'),
        OUTSIDE_SERVER: t('등록된 서버 범위 밖이거나 안전하게 해석할 수 없는 주소입니다.', 'The URL is outside the configured server or cannot be safely interpreted.'),
        INVALID_URL: t('서버 주소가 올바르지 않습니다.', 'The server URL is invalid.'),
        INVALID_RUN: t('선택한 빌드가 이 요청에 속하지 않습니다. 결과 목록에서 다시 선택해주세요.', 'The selected build does not belong to this request. Select it again from the results.'),
        INVALID_RESPONSE: t('서버 응답 형식이 올바르지 않습니다. Jenkins API 구성을 확인해주세요.', 'The server returned an invalid response. Check the Jenkins API configuration.'),
        RESPONSE_TOO_LARGE: t('응답이 크기 한도를 초과했습니다. Jenkins에서 상세 결과를 확인해주세요.', 'The response exceeds the size limit. Open Jenkins for full details.'),
        NOT_FOUND: t('요청한 작업이나 빌드를 찾을 수 없습니다.', 'The requested job or build was not found.'),
        HTTP_ERROR: t('서버가 요청을 처리하지 못했습니다. Jenkins 상태를 확인해주세요.', 'The server could not process the request. Check Jenkins health.'),
        CANCELLED: t('조회가 취소되었습니다.', 'The operation was cancelled.'),
        REQUEST_LIMIT: t('이번 회차의 조회 한도에 도달했습니다. 다음 조회에서 계속합니다.', 'This round reached its request limit. Tracking continues on the next refresh.'),
        DISCOVERY_LIMIT: t('탐색 범위 또는 연결 관계 한도에 도달했습니다. manifest로 전체 목록을 제공할 수 있습니다.', 'The discovery or relationship limit was reached. A manifest can supply the full inventory.'),
        INVALID_PARAMETER: t('빌드 파라미터가 올바르지 않습니다.', 'A build parameter is invalid.'),
        JENKINS_PARAMETER_CHOICE: t('파라미터 값이 작업의 허용된 선택지와 다릅니다.', 'A parameter value is not among the job’s allowed choices.'),
        JENKINS_SERVER_REMOVED: t('이 요청에 사용한 서버 설정이 삭제되었습니다.', 'The server configuration for this request was removed.'),
        JENKINS_REPORT_UNAVAILABLE: t('빌드 상세 보고서를 조회하지 못했습니다.', 'The detailed build report could not be retrieved.'),
        JENKINS_QUEUE_CANCELLED: t('Jenkins 대기열에서 실행이 취소되었습니다.', 'The build was cancelled in the Jenkins queue.'),
        JENKINS_QUEUE_EXPIRED: t('대기열 항목이 만료되어 빌드를 확인하지 못했습니다. Jenkins에서 확인해주세요.', 'The queue item expired before its build could be identified. Check Jenkins.'),
        JENKINS_TRACKING_TIMEOUT: t('결과 확인에 너무 오래 걸려 설정한 제한 시간에 조회를 종료했습니다. 확인된 결과는 보존하며 자동 재시도하지 않습니다. 다시 확인하려면 SHA 결과 다시 조회를 실행해주세요.', 'Result verification exceeded the configured time limit. Known results are retained and automatic checks have stopped. Run Check SHA results again to start a new observation.'),
        JENKINS_RESULTS_INCOMPLETE: t('일부 선택 테스트나 보고서를 확인하지 못해 자동 조회를 종료했습니다. 확인된 빌드 결과는 보존합니다.', 'Automatic checks stopped because some selected tests or reports could not be verified. Known build results are retained.'),
        JENKINS_ACTIVE_LIMIT: t('동시에 추적할 수 있는 요청은 20개입니다. 기존 요청을 중지하거나 지워주세요.', 'Up to 20 requests can be tracked. Stop or clear an existing request first.'),
        JENKINS_POLL_DEADLINE: t('이번 조회 시간이 끝났습니다. 다음 회차에서 계속합니다.', 'This polling round reached its deadline. Tracking continues on the next refresh.'),
        JENKINS_RUN_LIMIT: t('추적 빌드 수 한도에 도달했습니다. Jenkins에서 전체 결과를 확인해주세요.', 'The tracked-build limit was reached. Check Jenkins for the full result.'),
        JENKINS_STORAGE_LIMIT: t('이력 용량 한도로 추적을 중지했습니다. Jenkins에서 전체 결과를 확인해주세요.', 'Tracking stopped because the history size limit was reached. Check Jenkins for the full result.'),
        JENKINS_RESTORE_LIMIT: t('복원 가능한 추적 수 한도를 초과했습니다.', 'The restored tracking limit was exceeded.'),
        JENKINS_SERVER_LIMIT: t('등록 가능한 서버 수 한도를 초과했습니다.', 'The configured-server limit was exceeded.'),
        JENKINS_NEW_DESTINATION_REQUIRES_TOKEN: t('서버 주소나 계정을 바꾸면 새 토큰이 필요합니다.', 'A changed server URL or account requires a new token.'),
    };
    return labels[code ?? ''] ?? t('Jenkins 작업을 완료하지 못했습니다. 잠시 후 다시 시도하거나 Jenkins에서 상태를 확인해주세요.', 'The Jenkins operation could not be completed. Try again later or check Jenkins directly.');
}

/** A bounded, copyable report for a user-initiated identity check, without raw server data. */
export function jenkinsConnectionDiagnostic(serverUrl: string, error: unknown): string {
    const failure = error instanceof JenkinsClientError ? error : undefined;
    const diagnostic = failure?.diagnostic;
    const unknown = t('확인 불가', 'Unknown');
    let requestUrl = unknown;
    try { requestUrl = new URL('whoAmI/api/json', normalizeJenkinsServerUrl(serverUrl)).href.slice(0, 2048); }
    catch { /* Invalid stored configuration must not expose unvalidated text. */ }
    const status = diagnostic?.responseStatus ?? failure?.status;
    const identities = {
        anonymous: t('익명 사용자로 응답됨', 'Reported as anonymous'),
        'configured-user': t('등록한 사용자 이름과 일치', 'Matches the configured username'),
        'other-user': t('등록한 사용자 이름과 다름 (원문 생략)', 'Differs from the configured username (value omitted)'),
        'not-reported': t('서버가 인증 사용자 정보를 보내지 않음', 'The server did not report an authenticated identity'),
    };
    const types = {
        json: 'JSON', html: 'HTML', text: t('텍스트', 'Text'), other: t('기타', 'Other'), unknown,
    };
    const lines = [
        t('Jenkins 연결 진단', 'Jenkins connection diagnostics'),
        `${t('시각 (UTC)', 'Time (UTC)')}: ${new Date().toISOString()}`,
        `${t('연결 확인 요청', 'Connection check request')}: GET ${requestUrl}`,
        `${t('HTTP 상태', 'HTTP status')}: ${status ?? unknown}`,
        `${t('오류', 'Error')}: ${jenkinsErrorLabel(failure?.code)}`,
        `${t('응답 형식', 'Response format')}: ${types[diagnostic?.responseType ?? 'unknown']}`,
        `${t('X-Jenkins 헤더', 'X-Jenkins header')}: ${diagnostic?.jenkinsHeader === undefined ? unknown
            : diagnostic.jenkinsHeader ? t('있음 (서버가 보낸 단서)', 'Present (server-reported hint)') : t('없음 (Jenkins가 아니라고 단정할 수 없음)', 'Absent (does not rule out Jenkins)')}`,
        `${t('서버가 보고한 인증 상태', 'Server-reported identity')}: ${diagnostic?.authentication ? identities[diagnostic.authentication] : unknown}`,
    ];
    if (diagnostic?.requiredPermission) {
        lines.push(`${t('서버가 요구한 권한', 'Server-reported required permission')}: ${diagnostic.requiredPermission === 'other'
            ? t('기타 권한 (원문 생략)', 'Other permission (value omitted)') : diagnostic.requiredPermission}`);
    }
    if (diagnostic?.networkCode) { lines.push(`${t('네트워크/TLS 코드', 'Network/TLS code')}: ${diagnostic.networkCode}`); }
    if (diagnostic?.dispatched === false) {
        lines.push(t('이번 시도는 HTTP 전송 전에 중단되었습니다. 표시된 HTTP 상태는 이전 응답일 수 있습니다.',
            'This attempt stopped before HTTP dispatch. Any HTTP status shown may be from an earlier response.'));
    }
    if (failure?.deferred) {
        lines.push(t('재시도 대기 또는 로컬 준비 중 중단입니다. 계정·토큰을 수정했으면 저장한 뒤 다시 확인하고, 그렇지 않으면 잠시 기다려주세요.',
            'A retry delay or local preparation stopped this attempt. Save any account/token changes before checking again, or wait briefly.'));
    }
    lines.push('', t('연결 확인은 사용자 인증만 검사합니다. Job 조회·빌드 권한은 검사하지 않습니다.',
        'This check verifies identity only. It does not test job read or build permissions.'));
    if (failure?.code === 'FORBIDDEN' || failure?.code === 'AUTH_REQUIRED') {
        lines.push(t('사용자 ID와 사용자 설정에서 발급한 API 토큰을 확인하세요. 계정 비밀번호나 job 전용 빌드 토큰과는 다릅니다. 프록시/SSO가 API의 Basic 인증을 허용하고 Authorization 헤더를 전달하는지도 관리자에게 확인하세요.',
            'Check the user ID and the API token issued in that user’s settings, rather than an account password or job build token. Ask the administrator whether proxy/SSO policy permits API Basic authentication and forwards the Authorization header.'));
    }
    if (diagnostic?.requiredPermission === 'Overall/Read') {
        lines.push(t('서버가 Overall/Read 권한을 요구했습니다. 익명으로 표시되면 인증 전달부터 확인하고, 등록 계정으로 표시되면 해당 계정의 권한을 관리자에게 확인하세요.',
            'The server requested Overall/Read. If it reported anonymous access, check authentication forwarding first; if it reported the configured user, ask the administrator to check that account’s permissions.'));
    }
    if (diagnostic?.responseType === 'html' || failure?.code === 'REDIRECT') {
        lines.push(t('HTML 또는 리다이렉트는 로그인·프록시·오류 페이지일 수 있습니다. Jenkins의 직접 API 주소와 context path를 확인하세요. 리다이렉트 대상에는 인증정보를 보내지 않습니다.',
            'HTML or a redirect may indicate a login, proxy, or error page. Check the direct Jenkins API URL and context path. Credentials are not forwarded to redirect targets.'));
    }
    lines.push('', t('응답 본문·토큰·인증 헤더·쿠키·리다이렉트 주소는 포함하지 않습니다. 관리자에게 전달할 때는 이 시각과 요청 경로의 서버/프록시 로그를 확인하도록 요청하세요.',
        'Response bodies, tokens, authorization headers, cookies, and redirect URLs are omitted. Ask the administrator to check server/proxy logs for this time and request path.'));
    return lines.join('\n');
}

export function jenkinsStatusLabel(status: string): string {
    const labels: Record<string, string> = {
        partial: t('보고서 미확인', 'Report unverified'),
        passed: t('통과', 'PASS'), failed: t('실패', 'FAIL'), nonpass: t('통과 미확인', 'Not passed'),
        observedPassed: t('잠정 통과', 'Provisional pass'),
        timedout: t('조회 시간 만료', 'Observation timed out'), incomplete: t('조회 실패: 결과 미확인', 'Check failed: incomplete results'),
        queued: t('대기 중', 'Queued'), running: t('실행 중', 'Running'), unknown: t('결과 미확인', 'Result unverified'),
        unreachable: t('조회 불가', 'Unavailable'), aborted: t('실행 취소', 'Aborted'), skipped: t('건너뜀', 'Skipped'),
        sha_mismatch: t('체크아웃 SHA 불일치', 'Checkout SHA mismatch'), sending: t('요청 전송 중', 'Submitting'),
        unconfirmed: t('전송 결과 미확인', 'Submission unconfirmed'), stopped: t('추적 중지', 'Tracking stopped'),
        notSent: t('빌드 요청 전 중지', 'Not submitted'),
    };
    return Object.hasOwn(labels, status) ? labels[status] : labels.unknown;
}
