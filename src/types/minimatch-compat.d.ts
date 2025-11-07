/**
 * Provides the legacy `IOptions` and `IMinimatch` interfaces that
 * `@types/glob` still expects. Newer versions of `minimatch` ship their
 * own types without these aliases, which breaks `tsc --noEmit`.
 */
import type { Minimatch, MinimatchOptions } from 'minimatch';

declare module 'minimatch' {
    interface IOptions extends MinimatchOptions {}
    interface IMinimatch extends Minimatch {}
}
