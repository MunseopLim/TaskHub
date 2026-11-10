import * as assert from 'assert';
import { environmentValue, mergeProcessEnvironment, windowsCmdPath, windowsPowerShellPath } from '../processEnvironment';
import { resolveWindowsTaskSpawn, WindowsBatchArgumentError } from '../pipelineUtils';

suite('프로세스 환경과 시스템 셸', () => {
    test('Windows 환경 병합은 대소문자 중복을 제거하고 마지막 재정의를 적용한다', () => {
        const base = { PATH: 'old', TEMP: 'old-temp', KEEP: 'keep' };
        const overrides = { path: 'first', Path: 'last', Temp: '', removed: undefined };
        const merged = mergeProcessEnvironment(base, overrides, 'win32');
        assert.deepStrictEqual(merged, { KEEP: 'keep', Path: 'last', Temp: '', removed: undefined });
        assert.strictEqual(environmentValue(merged, 'PATH'), 'last');
        assert.deepStrictEqual(base, { PATH: 'old', TEMP: 'old-temp', KEEP: 'keep' });
        assert.deepStrictEqual(overrides, { path: 'first', Path: 'last', Temp: '', removed: undefined });
    });

    test('POSIX 환경은 대소문자가 다른 이름을 보존한다', () => {
        assert.deepStrictEqual(mergeProcessEnvironment({ PATH: 'upper' }, { path: 'lower' }, 'linux'),
            { PATH: 'upper', path: 'lower' });
    });

    test('소문자 PATH·PATHEXT도 배치 파일 인자 안전성 검사에 사용한다', () => {
        assert.throws(() => resolveWindowsTaskSpawn(false, 'tool', ['unsafe&value'], {
            env: { path: 'C:\\bin', pathext: '.CMD' },
            isFile: file => file.toLowerCase() === 'c:\\bin\\tool.cmd',
        }), WindowsBatchArgumentError);
    });

    test('셸은 호스트의 절대 경로를 사용하고 상대 환경값으로 cwd를 탐색하지 않는다', () => {
        assert.strictEqual(windowsPowerShellPath({ systemroot: 'D:\\Windows' }),
            'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        assert.strictEqual(windowsCmdPath({ comspec: 'D:\\Windows\\System32\\cmd.exe' }),
            'D:\\Windows\\System32\\cmd.exe');
        for (const unsafe of ['', '.', 'workspace', '\\Windows', 'C:Windows']) {
            assert.strictEqual(windowsCmdPath({ ComSpec: unsafe, SystemRoot: unsafe }), 'C:\\Windows\\System32\\cmd.exe');
            assert.strictEqual(windowsPowerShellPath({ SystemRoot: unsafe }),
                'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        }
    });
});
