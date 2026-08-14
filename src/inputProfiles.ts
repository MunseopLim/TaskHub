import { randomUUID } from 'crypto';
import type { Task } from './schema';
import { INTERACTIVE_TASK_TYPES } from './pipelineUtils';

export const INPUT_PROFILES_STATE_KEY = 'taskhub.inputProfiles.v1';
export const INPUT_PROFILE_NAME_MAX_LENGTH = 80;
export const INPUT_PROFILE_MAX_COUNT = 50;
export const INPUT_PROFILE_MAX_BYTES = 128 * 1024;
export const INPUT_PROFILES_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

interface PersistedInputProfileState {
    version: 1;
    profiles: unknown[];
    [key: string]: unknown;
}

interface LoadedInputProfileState {
    persisted: PersistedInputProfileState;
    profiles: NamedInputProfile[];
}

export interface NamedInputProfile {
    id: string;
    actionId: string;
    name: string;
    /** History와 같은 task-id keyed result 객체. password 입력은 절대 담지 않는다. */
    inputs: Record<string, unknown>;
    /** 저장 시점의 타입 서명. task id 재사용·타입 변경을 stale로 판정한다. */
    taskTypes: Record<string, string>;
    createdAt: number;
    updatedAt: number;
}

export interface InputProfileDraft {
    actionId: string;
    name: string;
    inputs: Record<string, unknown>;
    taskTypes: Record<string, string>;
}

export interface InputProfileInspection {
    /** 현재 액션에서도 같은 id·type으로 쓸 수 있는 값만 담는다. */
    usableInputs: Record<string, unknown>;
    /** 프로필에는 있지만 현재 액션에서 안전하게 대응시킬 수 없는 task id. */
    staleTaskIds: string[];
    /** 현재 액션이 다시 물어볼 저장 가능한 interactive task id. */
    promptTaskIds: string[];
}

export interface InputProfileMemento {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
}

export type InputProfileStoreErrorCode =
    | 'invalid-name'
    | 'duplicate-name'
    | 'not-found'
    | 'empty-inputs'
    | 'profile-too-large'
    | 'too-many-profiles'
    | 'store-too-large'
    | 'store-corrupt'
    | 'not-serializable';

export class InputProfileStoreError extends Error {
    constructor(public readonly code: InputProfileStoreErrorCode, message: string) {
        super(message);
        this.name = 'InputProfileStoreError';
    }
}

function normalizedProfileName(name: string): string {
    const normalized = typeof name === 'string' ? name.trim() : '';
    if (
        normalized.length === 0
        || normalized.length > INPUT_PROFILE_NAME_MAX_LENGTH
        || /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
        throw new InputProfileStoreError('invalid-name', 'Input profile name is empty or too long.');
    }
    return normalized;
}

function profileNameKey(name: string): string {
    return name.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSerializableRecord(
    value: Record<string, unknown>,
    sizeLimit: number,
    tooLargeCode: 'profile-too-large' | 'store-too-large'
): Record<string, unknown> {
    let encoded: string;
    try {
        encoded = JSON.stringify(value);
    } catch {
        throw new InputProfileStoreError('not-serializable', 'Input profile values are not JSON serializable.');
    }
    if (encoded === undefined) {
        throw new InputProfileStoreError('not-serializable', 'Input profile values are not JSON serializable.');
    }
    if (Buffer.byteLength(encoded, 'utf8') > sizeLimit) {
        throw new InputProfileStoreError(tooLargeCode, 'Input profile storage limit exceeded.');
    }
    const cloned: unknown = JSON.parse(encoded);
    if (!isRecord(cloned)) {
        throw new InputProfileStoreError('not-serializable', 'Input profile values must be an object.');
    }
    return cloned;
}

function ensureProfileFits(profile: InputProfileDraft | NamedInputProfile): void {
    let encoded: string;
    try {
        encoded = JSON.stringify(profile);
    } catch {
        throw new InputProfileStoreError('not-serializable', 'Input profile values are not JSON serializable.');
    }
    if (encoded === undefined) {
        throw new InputProfileStoreError('not-serializable', 'Input profile values are not JSON serializable.');
    }
    if (Buffer.byteLength(encoded, 'utf8') > INPUT_PROFILE_MAX_BYTES) {
        throw new InputProfileStoreError('profile-too-large', 'Input profile storage limit exceeded.');
    }
}

function isStorableInteractiveTask(task: Task | undefined): task is Task {
    return !!task
        && INTERACTIVE_TASK_TYPES.has(task.type)
        && !(task.type === 'inputBox' && task.password === true);
}

/**
 * History 입력으로 프로필 초안을 만든다.
 *
 * 현재 password task와 대응하는 키는 History가 잘못된 값을 들고 있더라도
 * 여기서 다시 제거한다. 알 수 없는 키는 버리지 않는다 — task id가 바뀐 오래된
 * History라는 증거이므로 프로필에 남겨 실행 시 stale로 알려야 한다.
 */
export function buildInputProfileDraft(
    actionId: string,
    name: string,
    tasks: Task[],
    historyInputs: Record<string, unknown>,
    historyTaskTypes?: Record<string, string>
): InputProfileDraft {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const inputs: Record<string, unknown> = Object.create(null);
    const taskTypes: Record<string, string> = Object.create(null);

    for (const taskId of Object.keys(historyInputs)) {
        const task = byId.get(taskId);
        if (task?.type === 'inputBox' && task.password === true) {
            continue;
        }
        inputs[taskId] = historyInputs[taskId];
        const recordedType = historyTaskTypes?.[taskId];
        if (typeof recordedType === 'string' && recordedType.length > 0) {
            taskTypes[taskId] = recordedType;
        }
    }

    if (Object.keys(inputs).length === 0) {
        throw new InputProfileStoreError('empty-inputs', 'No reusable inputs are available.');
    }

    const clonedInputs = cloneSerializableRecord(inputs, INPUT_PROFILE_MAX_BYTES, 'profile-too-large');
    if (Object.keys(clonedInputs).length === 0) {
        throw new InputProfileStoreError('empty-inputs', 'No reusable inputs are available.');
    }
    const draft: InputProfileDraft = {
        actionId,
        name: normalizedProfileName(name),
        inputs: clonedInputs,
        taskTypes: cloneSerializableRecord(taskTypes, INPUT_PROFILE_MAX_BYTES, 'profile-too-large') as Record<string, string>,
    };
    ensureProfileFits(draft);
    return draft;
}

/** 현재 액션 정의에 맞는 값과 다시 물어야 할 값을 분리한다. */
export function inspectInputProfile(profile: NamedInputProfile, tasks: Task[]): InputProfileInspection {
    const currentById = new Map(tasks.map(task => [task.id, task]));
    const usableInputs: Record<string, unknown> = Object.create(null);
    const staleTaskIds: string[] = [];

    for (const taskId of Object.keys(profile.inputs)) {
        const current = currentById.get(taskId);
        const savedType = profile.taskTypes[taskId];
        if (!isStorableInteractiveTask(current) || savedType !== current.type) {
            staleTaskIds.push(taskId);
            continue;
        }
        usableInputs[taskId] = profile.inputs[taskId];
    }

    const promptTaskIds = tasks
        .filter(isStorableInteractiveTask)
        .map(task => task.id)
        .filter(taskId => !Object.prototype.hasOwnProperty.call(usableInputs, taskId));

    return { usableInputs, staleTaskIds, promptTaskIds };
}

function validLoadedProfile(value: unknown): value is NamedInputProfile {
    if (!isRecord(value)) { return false; }
    if (
        typeof value.id !== 'string' || value.id.length === 0
        || typeof value.actionId !== 'string' || value.actionId.length === 0
        || typeof value.name !== 'string' || value.name.trim().length === 0
        || value.name.length > INPUT_PROFILE_NAME_MAX_LENGTH
        || /[\u0000-\u001f\u007f]/.test(value.name)
        || !isRecord(value.inputs) || Object.keys(value.inputs).length === 0
        || !isRecord(value.taskTypes)
        || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
        || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    ) {
        return false;
    }
    return Object.values(value.taskTypes).every(type => typeof type === 'string');
}

function readState(memento: InputProfileMemento): LoadedInputProfileState {
    const raw = memento.get<unknown>(INPUT_PROFILES_STATE_KEY, undefined);
    if (raw === undefined) {
        return {
            persisted: { version: 1, profiles: [] },
            profiles: [],
        };
    }
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.profiles)) {
        throw new InputProfileStoreError(
            'store-corrupt',
            'Input profile state is corrupt or was written by an unsupported version.'
        );
    }
    return {
        persisted: { ...raw, version: 1, profiles: raw.profiles },
        profiles: raw.profiles.filter(validLoadedProfile),
    };
}

function ensureStateFits(state: PersistedInputProfileState): void {
    let encoded: string;
    try {
        encoded = JSON.stringify(state);
    } catch {
        throw new InputProfileStoreError('not-serializable', 'Input profile state is not JSON serializable.');
    }
    if (Buffer.byteLength(encoded, 'utf8') > INPUT_PROFILES_MAX_TOTAL_BYTES) {
        throw new InputProfileStoreError('store-too-large', 'Input profile storage limit exceeded.');
    }
}

export class InputProfileStore {
    constructor(
        private readonly memento: InputProfileMemento,
        private readonly now: () => number = Date.now,
        private readonly makeId: () => string = randomUUID
    ) {}

    list(actionId: string): NamedInputProfile[] {
        return readState(this.memento).profiles
            .filter(profile => profile.actionId === actionId)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** 삭제된 액션의 orphan profile도 Command Palette에서 정리할 수 있게 전부 돌려준다. */
    listAll(): NamedInputProfile[] {
        return readState(this.memento).profiles.sort((a, b) =>
            a.actionId.localeCompare(b.actionId) || a.name.localeCompare(b.name)
        );
    }

    get(profileId: string): NamedInputProfile | undefined {
        return readState(this.memento).profiles.find(profile => profile.id === profileId);
    }

    findByName(actionId: string, name: string): NamedInputProfile | undefined {
        const key = profileNameKey(normalizedProfileName(name));
        return readState(this.memento).profiles.find(profile =>
            profile.actionId === actionId && profileNameKey(profile.name) === key
        );
    }

    async save(draft: InputProfileDraft, replaceId?: string): Promise<NamedInputProfile> {
        const state = readState(this.memento);
        const name = normalizedProfileName(draft.name);
        const replaceIndex = replaceId === undefined
            ? -1
            : state.profiles.findIndex(profile => profile.id === replaceId);
        if (replaceId !== undefined && replaceIndex < 0) {
            throw new InputProfileStoreError('not-found', 'Input profile not found.');
        }
        const duplicate = state.profiles.find(profile =>
            profile.actionId === draft.actionId
            && profile.id !== replaceId
            && profileNameKey(profile.name) === profileNameKey(name)
        );
        if (duplicate) {
            throw new InputProfileStoreError('duplicate-name', 'An input profile with this name already exists.');
        }
        if (replaceIndex < 0 && state.persisted.profiles.length >= INPUT_PROFILE_MAX_COUNT) {
            throw new InputProfileStoreError('too-many-profiles', 'Too many input profiles are stored.');
        }

        const inputs = cloneSerializableRecord(draft.inputs, INPUT_PROFILE_MAX_BYTES, 'profile-too-large');
        if (Object.keys(inputs).length === 0) {
            throw new InputProfileStoreError('empty-inputs', 'No reusable inputs are available.');
        }
        const taskTypes = cloneSerializableRecord(draft.taskTypes, INPUT_PROFILE_MAX_BYTES, 'profile-too-large') as Record<string, string>;
        if (!Object.values(taskTypes).every(type => typeof type === 'string')) {
            throw new InputProfileStoreError('not-serializable', 'Input profile task types are invalid.');
        }
        const timestamp = this.now();
        const previous = replaceIndex >= 0 ? state.profiles[replaceIndex] : undefined;
        if (previous && previous.actionId !== draft.actionId) {
            throw new InputProfileStoreError('not-found', 'Input profile belongs to another action.');
        }
        const profile: NamedInputProfile = {
            ...previous,
            id: previous?.id ?? this.makeId(),
            actionId: previous?.actionId ?? draft.actionId,
            name,
            inputs,
            taskTypes,
            createdAt: previous?.createdAt ?? timestamp,
            updatedAt: timestamp,
        };
        ensureProfileFits(profile);

        const persistedProfiles = [...state.persisted.profiles];
        if (replaceIndex >= 0) {
            const persistedIndex = persistedProfiles.indexOf(state.profiles[replaceIndex]);
            if (persistedIndex < 0) {
                throw new InputProfileStoreError('store-corrupt', 'Input profile state changed unexpectedly.');
            }
            persistedProfiles[persistedIndex] = profile;
        } else {
            persistedProfiles.push(profile);
        }
        const nextState: PersistedInputProfileState = {
            ...state.persisted,
            version: 1,
            profiles: persistedProfiles,
        };
        ensureStateFits(nextState);
        await this.memento.update(INPUT_PROFILES_STATE_KEY, nextState);
        return profile;
    }

    async rename(profileId: string, name: string): Promise<NamedInputProfile> {
        const profile = this.get(profileId);
        if (!profile) {
            throw new InputProfileStoreError('not-found', 'Input profile not found.');
        }
        return this.save({
            actionId: profile.actionId,
            name,
            inputs: profile.inputs,
            taskTypes: profile.taskTypes,
        }, profile.id);
    }

    async delete(profileId: string): Promise<boolean> {
        const state = readState(this.memento);
        let removed = false;
        const next = state.persisted.profiles.filter(value => {
            if (!removed && validLoadedProfile(value) && value.id === profileId) {
                removed = true;
                return false;
            }
            return true;
        });
        if (!removed) { return false; }
        await this.memento.update(INPUT_PROFILES_STATE_KEY, {
            ...state.persisted,
            version: 1,
            profiles: next,
        });
        return true;
    }
}
