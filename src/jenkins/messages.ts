import { t } from '../i18n';

/** Only known codes are translated; never display an arbitrary exception or response body. */
export function jenkinsErrorLabel(code?: string): string {
    if (code?.startsWith('JENKINS_SUBMISSION_UNCONFIRMED')) {
        return t('전송 결과를 확인하지 못했습니다. Jenkins 대기열을 확인해주세요. 자동 재전송하지 않습니다.', 'Submission could not be confirmed. Check the Jenkins queue; it will not be resubmitted automatically.');
    }
    const labels: Record<string, string> = {
        AUTH_REQUIRED: t('인증이 필요합니다. 사용자 이름과 API 토큰을 확인해주세요.', 'Authentication required. Check the username and API token.'),
        INVALID_CREDENTIALS: t('사용자 이름 또는 API 토큰이 없거나 유효하지 않습니다.', 'The username or API token is missing or invalid.'),
        FORBIDDEN: t('조회 또는 실행 권한이 없습니다. Jenkins 계정 권한을 확인해주세요.', 'Access denied. Check the Jenkins account’s read and build permissions.'),
        REDIRECT: t('로그인 페이지 또는 다른 주소로 이동하는 연결입니다. SSO 페이지 대신 직접 접근할 Jenkins API 주소를 설정해주세요.', 'The server redirects to a login page or another URL. Configure a direct Jenkins API URL instead of the SSO page.'),
        BACKOFF: t('서버 오류 후 재시도를 잠시 기다리고 있습니다.', 'Waiting before retrying after a server error.'),
        PERMISSION_LIMIT: t('권한 오류 추적 한도에 도달해 이 서버의 조회를 잠시 중지했습니다. 계정 권한을 확인해주세요.', 'The permission-error tracking limit was reached. Queries to this server are briefly paused; check account permissions.'),
        BUSY: t('조회 대기열이 가득 찼습니다. 잠시 후 다시 시도해주세요.', 'The request queue is full. Try again shortly.'),
        TIMEOUT: t('서버 응답 시간이 초과되었습니다. 연결 상태를 확인해주세요.', 'The server response timed out. Check connectivity.'),
        NETWORK_ERROR: t('서버에 연결하지 못했습니다. VPN·네트워크·인증서 설정을 확인해주세요.', 'Cannot connect to the server. Check VPN, network and certificate settings.'),
        INVALID_CA: t('CA 인증서를 읽거나 검증하지 못했습니다. PEM 파일을 확인해주세요.', 'Cannot read or validate the CA certificate. Check the PEM file.'),
        INSECURE_HTTP: t('HTTP 연결이 차단되었습니다. HTTPS를 사용하거나 서버 설정에서 평문 전송을 명시적으로 허용해주세요.', 'HTTP is blocked. Use HTTPS or explicitly allow unencrypted transport in server settings.'),
        OUTSIDE_SERVER: t('등록된 서버 범위 밖이거나 안전하게 해석할 수 없는 주소입니다.', 'The URL is outside the configured server or cannot be safely interpreted.'),
        INVALID_URL: t('서버 주소가 올바르지 않습니다.', 'The server URL is invalid.'),
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
        JENKINS_TRACKING_TIMEOUT: t('추적 기간이 끝났습니다. Jenkins에서 남은 결과를 확인해주세요.', 'The tracking period ended. Check Jenkins for remaining results.'),
        JENKINS_POLL_DEADLINE: t('이번 조회 시간이 끝났습니다. 다음 회차에서 계속합니다.', 'This polling round reached its deadline. Tracking continues on the next refresh.'),
        JENKINS_RUN_LIMIT: t('추적 빌드 수 한도에 도달했습니다. Jenkins에서 전체 결과를 확인해주세요.', 'The tracked-build limit was reached. Check Jenkins for the full result.'),
        JENKINS_STORAGE_LIMIT: t('이력 용량 한도로 추적을 중지했습니다. Jenkins에서 전체 결과를 확인해주세요.', 'Tracking stopped because the history size limit was reached. Check Jenkins for the full result.'),
        JENKINS_RESTORE_LIMIT: t('복원 가능한 추적 수 한도를 초과했습니다.', 'The restored tracking limit was exceeded.'),
        JENKINS_SERVER_LIMIT: t('등록 가능한 서버 수 한도를 초과했습니다.', 'The configured-server limit was exceeded.'),
        JENKINS_NEW_DESTINATION_REQUIRES_TOKEN: t('서버 주소나 계정을 바꾸면 새 토큰이 필요합니다.', 'A changed server URL or account requires a new token.'),
    };
    return labels[code ?? ''] ?? t('Jenkins 작업을 완료하지 못했습니다. 잠시 후 다시 시도하거나 Jenkins에서 상태를 확인해주세요.', 'The Jenkins operation could not be completed. Try again later or check Jenkins directly.');
}

export function jenkinsStatusLabel(status: string): string {
    const labels: Record<string, string> = {
        partial: t('보고서 미확인', 'Report unverified'),
        passed: t('통과', 'PASS'), failed: t('실패', 'FAIL'), nonpass: t('통과 미확인', 'Not passed'),
        queued: t('대기 중', 'Queued'), running: t('실행 중', 'Running'), unknown: t('확인 중', 'Unverified'),
        unreachable: t('조회 불가', 'Unavailable'), aborted: t('실행 취소', 'Aborted'), skipped: t('건너뜀', 'Skipped'),
        sha_mismatch: t('체크아웃 SHA 불일치', 'Checkout SHA mismatch'), sending: t('요청 전송 중', 'Submitting'),
        unconfirmed: t('전송 결과 미확인', 'Submission unconfirmed'), stopped: t('추적 중지', 'Tracking stopped'),
    };
    return labels[status] ?? labels.unknown;
}
