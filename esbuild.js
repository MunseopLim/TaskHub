const esbuild = require("esbuild");
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const standaloneCode = require('ajv/dist/standalone').default;

// dialogMemory도 한 벌만 쓴다. 기능 번들에 각각 넣으면 활성화에서 초기화한 기억과 분리된다.
const featureModules = ['jsonEditor', 'memoryMapViewer', 'hexViewer', 'hexConverter', 'actionRunReport', 'dialogMemory'];
const externalModulePaths = new Set(featureModules.map(name => path.join(__dirname, 'src', name)));
const featureBoundaryPlugin = {
    name: 'feature-boundaries',
    setup(build) {
        build.onResolve({ filter: /^\./ }, args => {
            if (args.kind === 'entry-point') { return; }
            const resolved = path.resolve(args.resolveDir, args.path).replace(/\.ts$/, '');
            if (externalModulePaths.has(resolved)) {
                return { path: './' + path.basename(resolved) + '.js', external: true };
            }
        });
    },
};

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * `.vscode/tasks.json` 의 background 문제 매처가 읽는 시작/끝 신호를 낸다.
 *
 * **번들이 여러 개여도 한 쌍만 낸다.** 설정마다 따로 내면 한 번의 빌드에 begin/end 가
 * 두 쌍 나오고, F5 의 preLaunchTask 가 **첫 번째 finished** 를 보고 빌드가 끝났다고
 * 판단해 나머지 번들이 아직 디스크에 써지는 중에 확장이 뜬다.
 *
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = (() => {
	let outstanding = 0;
	return {
		name: 'esbuild-problem-matcher',

		setup(build) {
			build.onStart(() => {
				if (outstanding === 0) {
					console.log('[watch] build started');
				}
				outstanding++;
			});
			build.onEnd((result) => {
				if (result.metafile && result.errors.length === 0) {
					const name = path.basename(build.initialOptions.outfile || 'features', '.js');
					const directory = path.join(__dirname, 'out', 'build');
					fs.mkdirSync(directory, { recursive: true });
					fs.writeFileSync(path.join(directory, `${name}.meta.json`), JSON.stringify(result.metafile));
				}
				result.errors.forEach(({ text, location }) => {
					console.error(`✘ [ERROR] ${text}`);
					if (location) { console.error(`    ${location.file}:${location.line}:${location.column}:`); }
				});
				outstanding--;
				if (outstanding === 0) {
					console.log('[watch] build finished');
				}
			});
		},
	};
})();

/**
 * 확장 호스트 번들 (Node).
 */
const extensionConfig = {
	entryPoints: [
		'src/extension.ts'
	],
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	metafile: true,
	outfile: 'dist/extension.js',
	external: ['vscode'],
	logLevel: 'silent',
	plugins: [
        featureBoundaryPlugin,
		esbuildProblemMatcherPlugin,
	],
};

/**
 * JSON Editor webview 번들 (브라우저).
 *
 * webview 스크립트가 쓰는 **순수 로직의 단일 출처**를 담는다. 예전에는 같은
 * 로직이 두 벌이었다 — 하나는 `getWebviewContent` 의 템플릿 리터럴 안(타입체크도
 * 린트도 걸리지 않는 문자열), 하나는 `src/jsonEditorUtils.ts` 의 "테스트용 미러".
 * 두 벌은 반드시 어긋나므로, 이제 webview 가 미러를 **직접 불러 쓴다.**
 *
 * IIFE + globalName 이라 로드되면 전역 하나만 남긴다. 인라인 스크립트는 그
 * 전역에서 필요한 것을 꺼내 쓴다.
 */
const webviewConfig = {
	entryPoints: [
		'src/webview/jsonEditorLogic.ts'
	],
	bundle: true,
	format: 'iife',
	globalName: 'TaskHubJsonEditorLogic',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'browser',
	metafile: true,
	target: 'es2022',
	outfile: 'dist/jsonEditorWebview.js',
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

/**
 * 사용자 정규식 worker 번들 (Node, `worker_threads`).
 *
 * 출력 캡처·진단의 사용자 정규식을 확장 호스트 밖에서 실행한다. 호스트 번들이
 * `__dirname` 기준으로 같은 `dist/`에서 찾으므로 파일 이름을 바꾸지 않는다.
 */
const regexWorkerConfig = {
	entryPoints: [
		'src/regexWorker.ts'
	],
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	metafile: true,
	outfile: 'dist/regexWorker.js',
	// `vscode` 를 external 로 두지 않는다. worker 에는 vscode API 가 없으므로
	// 의존성 쪽으로 import 가 새어 들어오면 실행이 아니라 빌드에서 실패해야 한다.
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

const featureConfig = {
    ...extensionConfig,
    entryPoints: Object.fromEntries(featureModules.map(name => [name, `src/${name}.ts`])),
    outfile: undefined,
    outdir: 'dist',
};

const validatorConfig = {
    ...extensionConfig,
    entryPoints: ['actions-validator'],
    outfile: 'dist/actionsValidator.js',
    plugins: [{
        name: 'precompile-actions-schema',
        setup(build) {
            build.onResolve({ filter: /^actions-validator$/ }, () => ({ path: 'actions-validator', namespace: 'schema' }));
            build.onLoad({ filter: /.*/, namespace: 'schema' }, () => {
                const schemaPath = path.join(__dirname, 'schema', 'actions.schema.json');
                const ajv = new Ajv({ allErrors: true, inlineRefs: false, code: { source: true } });
                const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
                return {
                    contents: standaloneCode(ajv, validate),
                    loader: 'js',
                    resolveDir: __dirname,
                    watchFiles: [schemaPath],
                };
            });
        },
    }, esbuildProblemMatcherPlugin],
};

async function main() {
	const contexts = await Promise.all(
		[extensionConfig, featureConfig, validatorConfig, webviewConfig, regexWorkerConfig].map(config => esbuild.context(config))
	);
	if (watch) {
		await Promise.all(contexts.map(ctx => ctx.watch()));
	} else {
		await Promise.all(contexts.map(async ctx => {
			await ctx.rebuild();
			await ctx.dispose();
		}));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
