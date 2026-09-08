import * as http from 'node:http';
import * as https from 'node:https';
import { TextDecoder } from 'node:util';

const REQUEST_TIMEOUT_MS = 2000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MAX_TITLE_LENGTH = 200;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const TITLE_ENTITIES: Readonly<Record<string, string>> = {
    amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>',
    quot: '"', QUOT: '"', apos: "'", nbsp: ' ',
    ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©',
    reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥',
    cent: '¢', times: '×', divide: '÷', plusmn: '±', deg: '°',
};

function parseTitleUrl(rawUrl: string, base?: URL): URL | undefined {
    try {
        const url = new URL(rawUrl, base);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
            return url;
        }
    } catch {
        // 제목 제안 실패가 링크 추가를 막지 않게 한다.
    }
    return undefined;
}

function decodeTitleEntity(entity: string, value: string): string {
    if (!value.startsWith('#')) {
        return Object.prototype.hasOwnProperty.call(TITLE_ENTITIES, value) ? TITLE_ENTITIES[value] : entity;
    }
    const hexadecimal = value[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(value.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return '\ufffd';
    }
    return String.fromCodePoint(codePoint);
}

function extractTitle(body: Buffer, contentType: string): string | undefined {
    try {
        const headerCharset = /;\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType);
        // HTTP 헤더에 charset이 없는 오래된 페이지의 meta charset도 읽는다.
        const prefix = body.subarray(0, 1024).toString('latin1');
        const metaCharset = /<meta\b[^<>]*\bcharset\s*=\s*["']?\s*([^\s"';/>]+)/i.exec(prefix);
        const bomCharset = body[0] === 0xff && body[1] === 0xfe
            ? 'utf-16le'
            : body[0] === 0xfe && body[1] === 0xff ? 'utf-16be' : undefined;
        const charset = bomCharset ?? headerCharset?.slice(1).find(Boolean) ?? metaCharset?.[1] ?? 'utf-8';
        // 청크 끝의 미완성 멀티바이트 문자는 보류한다. 이미 닫힌 title 뒤의
        // 문자가 반만 도착했다는 이유로 정상 제목까지 잃지 않게 한다.
        const html = new TextDecoder(charset, { fatal: true }).decode(body, { stream: true });
        // 주석과 script/style 안의 예시 <title>을 페이지 제목으로 오인하지 않는다.
        const markup = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
        const opening = /<title\b[^<>]*>/i.exec(markup);
        if (!opening) {
            return undefined;
        }
        const titleStart = opening.index + opening[0].length;
        // 닫는 태그 검색을 분리해 끝나지 않는 <title> 반복 입력을 재탐색하지 않는다.
        const closing = /<\/title\s*>/i.exec(markup.slice(titleStart));
        if (!closing) {
            return undefined;
        }
        const title = markup.slice(titleStart, titleStart + closing.index)
            .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, decodeTitleEntity)
            .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return title ? Array.from(title).slice(0, MAX_TITLE_LENGTH).join('') : undefined;
    } catch {
        // 알 수 없는 charset이나 손상된 텍스트는 기존 제목 기본값으로 폴백한다.
        return undefined;
    }
}

/** 사용자에게 제안할 HTML 제목만 조회한다. 실패·취소는 항상 undefined다. */
export async function fetchLinkTitle(rawUrl: string, signal?: AbortSignal): Promise<string | undefined> {
    const initialUrl = parseTitleUrl(rawUrl);
    if (!initialUrl || signal?.aborted) {
        return undefined;
    }

    return new Promise(resolve => {
        let settled = false;
        let activeRequest: http.ClientRequest | undefined;
        let activeResponse: http.IncomingMessage | undefined;
        const onAbort = () => finish();
        // 리다이렉트나 느리게 들어오는 본문이 제한 시간을 다시 시작하지 않는다.
        const deadline = setTimeout(() => finish(), REQUEST_TIMEOUT_MS);

        function finish(title?: string): void {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(deadline);
            signal?.removeEventListener('abort', onAbort);
            activeResponse?.destroy();
            activeRequest?.destroy();
            resolve(title);
        }

        function requestTitle(url: URL, redirects: number): void {
            if (settled) {
                return;
            }
            try {
                const request = (url.protocol === 'https:' ? https : http).request(url, {
                    agent: false,
                    headers: {
                        Accept: 'text/html, application/xhtml+xml',
                        'Accept-Encoding': 'identity',
                    },
                });
                activeRequest = request;
                request.on('error', () => {
                    if (activeRequest === request) {
                        finish();
                    }
                });
                request.on('response', response => {
                    if (settled || activeRequest !== request) {
                        response.destroy();
                        return;
                    }
                    activeResponse = response;
                    const failResponse = () => {
                        if (activeResponse === response) {
                            finish();
                        }
                    };
                    response.on('error', failResponse);
                    response.on('aborted', failResponse);
                    const status = response.statusCode ?? 0;
                    if (REDIRECT_STATUSES.has(status)) {
                        const nextUrl = response.headers.location
                            ? parseTitleUrl(response.headers.location, url)
                            : undefined;
                        if (!nextUrl || redirects >= MAX_REDIRECTS) {
                            finish();
                            return;
                        }
                        // 이전 요청의 destroy 이벤트가 새 요청을 실패시키지 않게 분리한다.
                        activeResponse = undefined;
                        activeRequest = undefined;
                        response.destroy();
                        request.destroy();
                        requestTitle(nextUrl, redirects + 1);
                        return;
                    }

                    const contentType = response.headers['content-type'] ?? '';
                    const encoding = response.headers['content-encoding']?.trim().toLowerCase();
                    if (status < 200 || status >= 300
                        || !/^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(contentType)
                        || (encoding && encoding !== 'identity')) {
                        finish();
                        return;
                    }

                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    response.on('data', (chunk: Buffer) => {
                        if (settled) {
                            return;
                        }
                        const remaining = MAX_RESPONSE_BYTES - bytes;
                        const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
                        bytes += accepted.length;
                        chunks.push(accepted);
                        // 문서 전체를 받지 않고 제목이 완성되는 즉시 연결을 닫는다.
                        // 큰 chunk도 한도 안의 부분만 보관하고 검사한다.
                        const title = extractTitle(Buffer.concat(chunks, bytes), contentType);
                        if (title !== undefined) {
                            finish(title);
                        } else if (bytes >= MAX_RESPONSE_BYTES) {
                            finish();
                        }
                    });
                    response.on('end', () => {
                        if (!settled) {
                            finish(extractTitle(Buffer.concat(chunks, bytes), contentType));
                        }
                    });
                });
                request.end();
            } catch {
                finish();
            }
        }

        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
            finish();
        } else {
            requestTitle(initialUrl, 0);
        }
    });
}
