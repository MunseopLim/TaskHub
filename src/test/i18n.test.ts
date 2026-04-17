import * as assert from 'assert';
import * as vscode from 'vscode';
import { t } from '../i18n';

suite('i18n Test Suite', () => {
    test('returns one of the two provided strings', () => {
        const result = t('안녕', 'hello');
        assert.ok(result === '안녕' || result === 'hello',
            `expected one of the two localized strings, got: ${result}`);
    });

    test('agrees with vscode.env.language', () => {
        const result = t('KO', 'EN');
        if (vscode.env.language.startsWith('ko')) {
            assert.strictEqual(result, 'KO');
        } else {
            assert.strictEqual(result, 'EN');
        }
    });

    test('preserves interpolated values from template literals', () => {
        const value = 42;
        const result = t(`값=${value}`, `value=${value}`);
        assert.ok(result.includes('42'), `result should contain the interpolated number, got: ${result}`);
    });

    test('handles empty strings without throwing', () => {
        const result = t('', '');
        assert.strictEqual(result, '');
    });
});
