import type { InputProfileMemento, InputProfileStore, NamedInputProfile } from './inputProfiles';

export const PINNED_ACTIONS_STATE_KEY = 'taskhub.pinnedActions.v1';
export const PINNED_ACTIONS_MAX_COUNT = 100;
const MAX_STATE_BYTES = 128 * 1024;

/** 입력값과 표시 이름은 복사하지 않고 현재 액션·프로필을 참조한다. */
export interface PinnedActionReference {
    actionId: string;
    profileId?: string;
}

interface PinnedActionState {
    version: 1;
    pins: PinnedActionReference[];
    [key: string]: unknown;
}

export class PinnedActionStoreError extends Error {
    constructor(public readonly code: 'store-corrupt' | 'too-many-pins' | 'store-too-large') {
        super(code);
        this.name = 'PinnedActionStoreError';
    }
}

export function pinnedActionKey(pin: PinnedActionReference): string {
    return JSON.stringify([pin.actionId, pin.profileId ?? null]);
}

export function findPinnedInputProfile(pin: PinnedActionReference, profiles: InputProfileStore): NamedInputProfile | undefined {
    const matches = profiles.listAll().filter(profile => profile.id === pin.profileId);
    return matches.length === 1 && matches[0].actionId === pin.actionId ? matches[0] : undefined;
}

function validPin(value: unknown): value is PinnedActionReference {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const pin = value as Record<string, unknown>;
    return typeof pin.actionId === 'string' && pin.actionId.length > 0
        && (pin.profileId === undefined || (typeof pin.profileId === 'string' && pin.profileId.length > 0));
}

function copyPin(pin: PinnedActionReference): PinnedActionReference {
    return pin.profileId === undefined ? { actionId: pin.actionId } : { actionId: pin.actionId, profileId: pin.profileId };
}

export class PinnedActionStore {
    private pending: Promise<unknown> = Promise.resolve();

    constructor(private readonly memento: InputProfileMemento) {}

    private read(): PinnedActionState {
        const raw = this.memento.get<unknown>(PINNED_ACTIONS_STATE_KEY, undefined);
        if (raw === undefined) { return { version: 1, pins: [] }; }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new PinnedActionStoreError('store-corrupt');
        }
        const state = raw as PinnedActionState;
        if (state.version !== 1 || !Array.isArray(state.pins) || !state.pins.every(validPin)
            || new Set(state.pins.map(pinnedActionKey)).size !== state.pins.length) {
            throw new PinnedActionStoreError('store-corrupt');
        }
        return state;
    }

    list(): PinnedActionReference[] {
        return this.read().pins.map(copyPin);
    }

    has(pin: PinnedActionReference): boolean {
        return validPin(pin) && this.list().some(existing => pinnedActionKey(existing) === pinnedActionKey(pin));
    }

    private serializeMutation<T>(change: () => Promise<T>): Promise<T> {
        const next = this.pending.then(change);
        this.pending = next.catch(() => undefined);
        return next;
    }

    add(pin: PinnedActionReference): Promise<boolean> {
        return this.serializeMutation(async () => {
            if (!validPin(pin)) { throw new PinnedActionStoreError('store-corrupt'); }
            const state = this.read();
            if (state.pins.some(existing => pinnedActionKey(existing) === pinnedActionKey(pin))) { return false; }
            if (state.pins.length >= PINNED_ACTIONS_MAX_COUNT) { throw new PinnedActionStoreError('too-many-pins'); }
            const next = { ...state, pins: [...state.pins, copyPin(pin)] };
            if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_STATE_BYTES) {
                throw new PinnedActionStoreError('store-too-large');
            }
            await this.memento.update(PINNED_ACTIONS_STATE_KEY, next);
            return true;
        });
    }

    remove(pin: PinnedActionReference): Promise<boolean> {
        return this.serializeMutation(async () => {
            if (!validPin(pin)) { return false; }
            const state = this.read();
            const pins = state.pins.filter(existing => pinnedActionKey(existing) !== pinnedActionKey(pin));
            if (pins.length === state.pins.length) { return false; }
            await this.memento.update(PINNED_ACTIONS_STATE_KEY, { ...state, pins });
            return true;
        });
    }
}
