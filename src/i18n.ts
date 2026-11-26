import * as vscode from 'vscode';
import { translator } from './language';

export const t = translator(() => vscode.env.language);
