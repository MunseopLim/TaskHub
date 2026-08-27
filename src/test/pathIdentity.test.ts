import * as assert from 'assert';
import { filePathIdentityKey } from '../pathIdentity';

suite('파일 경로 identity', () => {
    test('Windows 드라이브 문자와 경로 대소문자를 같은 파일로 취급한다', () => {
        assert.strictEqual(
            filePathIdentityKey('C:\\Build\\Firmware.ELF', 'win32'),
            filePathIdentityKey('c:\\build\\firmware.elf', 'win32'),
        );
    });

    test('Windows 경로의 상대 구간을 해소한 뒤 비교한다', () => {
        assert.strictEqual(
            filePathIdentityKey('C:\\Build\\debug\\..\\app.axf', 'win32'),
            filePathIdentityKey('c:\\build\\app.axf', 'win32'),
        );
    });

    test('POSIX 경로의 대소문자는 서로 다른 파일로 유지한다', () => {
        assert.notStrictEqual(
            filePathIdentityKey('/tmp/Build/app.elf', 'linux'),
            filePathIdentityKey('/tmp/build/app.elf', 'linux'),
        );
    });
});
