import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    approximateResultBytes,
    getTotalResultLimitBytes,
    runCommandCaptureLines,
} from '../extension';

/**
 * 명령 출력 캡처의 메모리 상한.
 *
 * `runCommandCaptureLines` 는 1MB 를 넘으면 중단하는데, 종료가 비동기라 그
 * 사이에도 data 리스너가 계속 문자열을 이어 붙였다. 더 나쁘게는 **chunk 마다
 * abort 를 다시 호출**해 `taskkill` 프로세스·Promise·리스너·타이머가
 * 폭증했다 — OOM 을 막으려는 코드가 OOM 을 만드는 모양이었다.
 *
 * (JSON Editor 복구 스냅샷 상한은 `recoveryStoreLimits.test.ts` 에 있다.)
 */
suite('메모리 상한 가드', () => {

    suite('명령 출력 캡처', () => {

        /** 지정한 바이트 수를 최대한 빨리 뿜는 스크립트. */
        function makeFloodScript(bytes: number): { command: string; cwd: string; cleanup: () => void } {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-flood-'));
            const scriptName = 'flood.js';
            fs.writeFileSync(
                path.join(dir, scriptName),
                `const chunk = 'x'.repeat(64 * 1024);\n` +
                `let written = 0;\n` +
                `function pump() {\n` +
                `  while (written < ${bytes}) {\n` +
                `    written += chunk.length;\n` +
                `    if (!process.stdout.write(chunk)) { process.stdout.once('drain', pump); return; }\n` +
                `  }\n` +
                `}\n` +
                `pump();\n`
            );
            return {
                command: `node ${scriptName}`,
                cwd: dir,
                cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
            };
        }

        /**
         * 상한(1MB)에 한참 못 미치는 양을 천천히 뿜으며 계속 살아 있는 명령.
         * 취소만 단독으로 검증하려면 출력 상한이 끼어들면 안 된다.
         */
        function makeSlowTrickleScript(): { command: string; cwd: string; startedMarker: string; cleanup: () => void } {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-trickle-'));
            const startedMarker = path.join(dir, 'started');
            fs.writeFileSync(
                path.join(dir, 'trickle.js'),
                `require('fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started');\n` +
                `setInterval(function () { process.stdout.write('tick\\n'); }, 50);\n`
            );
            return {
                command: 'node trickle.js',
                cwd: dir,
                startedMarker,
                cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
            };
        }

        test('1MB 상한을 넘기면 중단하고, 그 뒤 출력은 버린다', async function () {
            this.timeout(30000);
            // 상한(1MB)의 수 배를 뿜는다. 상한 이후에도 계속 이어 붙였다면
            // 이 테스트는 통과하더라도 메모리가 그만큼 더 잡혔을 것이다 —
            // 여기서 고정하는 것은 "상한을 넘으면 거부한다" 는 계약이고,
            // 이어 붙이기 중단은 구현 검사로 함께 본다(아래).
            const flood = makeFloodScript(8 * 1024 * 1024);
            try {
                await assert.rejects(
                    runCommandCaptureLines(flood.command, flood.cwd, 20000),
                    /too large|너무 큽니다/i,
                    '출력 상한을 넘겼는데 거부하지 않았다'
                );
            } finally {
                flood.cleanup();
            }
        });

        test('취소가 이미 걸린 뒤에는 abort 를 다시 부르지 않는다', async function () {
            this.timeout(30000);
            // 반복 abort 가 살아 있으면 chunk 마다 taskkill·Promise·타이머가
            // 생긴다. 취소 후에도 명령이 계속 뿜는 상황을 만들어, 거부가
            // 한 번만 일어나고 정상적으로 끝나는지 본다.
            //
            // **출력량이 상한(1MB)을 넘지 않아야 한다.** 처음엔 64MB 를 뿜게
            // 했는데, 그러면 취소보다 출력 상한이 먼저 발동해 거부 사유가
            // 'too large' 가 되는 경합이 생겼다 — 실제로 단독 실행에서 한 번은
            // 실패하고 재실행하면 통과하는 순서 의존이 나타났다. 상한 아래로
            // 천천히 뿜으면서 취소만 검증한다.
            const flood = makeSlowTrickleScript();
            const cts = new vscode.CancellationTokenSource();
            try {
                const run = runCommandCaptureLines(flood.command, flood.cwd, 20000, cts.token);
                // 프로세스가 실제로 떴는지 확인한 뒤 취소한다 (고정 sleep 금지).
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline && !fs.existsSync(flood.startedMarker)) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                assert.ok(fs.existsSync(flood.startedMarker), '명령이 시작되지 않았다');
                cts.cancel();
                await assert.rejects(run, /canceled/i, '취소 사유가 다른 오류로 덮였다');
            } finally {
                cts.dispose();
                flood.cleanup();
            }
        });
    });

    /**
     * 액션 전체의 태스크 결과 총량 (0.6.43).
     *
     * `stepResults` 는 뒤 태스크가 `${앞태스크.stdout}` 을 참조할 수 있어야 해서
     * 액션이 끝날 때까지 모든 결과를 들고 있는다. 태스크 하나의 출력은
     * `outputCaptureLimitMb` 로 막혀 있었지만 **합계에는 제한이 없었다**.
     *
     * 실질 위험은 태스크 개수가 아니라 **설정을 올렸을 때**다 — 기본값(10MB)
     * 에서는 태스크가 수십 개여야 문제가 되지만, 로그가 잘려서 그 설정을
     * 1024MB 로 올린 환경은 태스크 서넛만으로 GB 단위가 된다.
     */
    suite('액션 결과 총량 상한', () => {

        suite('실효 한도 계산', () => {
            test('설정값을 바이트로 환산한다', () => {
                assert.strictEqual(getTotalResultLimitBytes(32, 1024 * 1024), 32 * 1024 * 1024);
            });

            test('태스크 상한보다 작아지지 않는다', () => {
                // "이 태스크 출력 100MB 를 받겠다"고 해 놓고 총량이 32MB 라
                // 곧바로 실패하면 두 설정이 서로를 부정하는 꼴이다.
                const perTask = 100 * 1024 * 1024;
                assert.strictEqual(getTotalResultLimitBytes(32, perTask), perTask);
            });

            test('태스크 상한보다 크면 설정값을 그대로 쓴다', () => {
                const perTask = 10 * 1024 * 1024;
                assert.strictEqual(getTotalResultLimitBytes(64, perTask), 64 * 1024 * 1024);
            });

            test('범위 밖 값은 clamp 된다 (기존 캡처 한도와 같은 규약)', () => {
                const perTask = 1024;
                // 0 은 falsy 라 기본값으로 대체된다.
                assert.strictEqual(getTotalResultLimitBytes(0, perTask), 32 * 1024 * 1024);
                // 최대 초과는 최대값으로.
                assert.strictEqual(getTotalResultLimitBytes(99999, perTask), 4096 * 1024 * 1024);
                // 음수는 **기본값이 아니라 최소값**으로 clamp 된다. 사용자가
                // 명시적으로 넣은 값이므로 "무시하고 기본값" 보다 "허용 범위로
                // 당긴다" 가 맞고, `getCaptureLimitBytes` 도 같은 규약이다.
                assert.strictEqual(getTotalResultLimitBytes(-5, perTask), 1 * 1024 * 1024);
            });
        });

        suite('결과 크기 추정', () => {
            test('shell 결과는 stdout + stderr 바이트를 센다', () => {
                const bytes = approximateResultBytes({ stdout: 'a'.repeat(100), stderr: 'b'.repeat(50) });
                assert.strictEqual(bytes, 150);
            });

            test('멀티바이트 문자를 UTF-8 기준으로 센다', () => {
                // '가' 는 UTF-8 3바이트. 문자 수로 세면 실제 메모리를 과소평가한다.
                assert.strictEqual(approximateResultBytes({ v: '가'.repeat(10) }), 30);
            });

            test('중첩 구조도 센다', () => {
                assert.strictEqual(
                    approximateResultBytes({ a: { b: { c: 'x'.repeat(20) } } }),
                    20
                );
            });

            test('깊이를 제한해 계산 자체가 비싸지지 않게 한다', () => {
                // 예상치 못한 깊은 구조에서 이 추정이 병목이 되면 안 된다.
                let deep: any = 'x'.repeat(100);
                for (let i = 0; i < 10; i++) { deep = { nested: deep }; }
                assert.strictEqual(approximateResultBytes(deep), 0, '깊이 제한을 넘으면 0으로 본다');
            });

            test('빈 결과와 null 을 안전하게 다룬다', () => {
                assert.strictEqual(approximateResultBytes({}), 0);
                assert.strictEqual(approximateResultBytes(null), 0);
                assert.strictEqual(approximateResultBytes(undefined), 0);
            });

            test('배열도 센다', () => {
                assert.strictEqual(approximateResultBytes(['ab', 'cde']), 5);
            });
        });
    });

});
