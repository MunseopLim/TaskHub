/**
 * Defines the structure for an item in the actions.json file.
 * This can be a clickable action, a separator, or a folder containing other items.
 */
export interface ActionItem {
    id: string;
    title: string;
    type?: 'separator' | 'folder';
    action?: Action;
    children?: ActionItem[];
}

/**
 * Represents a runnable action, which consists of a sequence of tasks.
 */
export interface Action {
    description: string;
    tasks: Task[];
    successMessage?: string;
    failMessage?: string;
}

/**
 * Represents a single task, the fundamental unit of execution.
 */
export interface Task {
    id: string;
    type: 'shell' | 'command' | 'fileDialog' | 'folderDialog' | 'unzip' | 'zip' | 'stringManipulation';

    // Properties for 'shell' and 'command' types
    command?: string | { 
        windows?: string;
        macos?: string;
        linux?: string;
    };
    args?: string[];
    cwd?: string;
    revealTerminal?: 'always' | 'silent' | 'never';

    // Properties for 'fileDialog' and 'folderDialog'
    options?: any; // Corresponds to vscode.OpenDialogOptions

    // Properties for 'unzip' and 'zip'
    tool?: string | { 
        windows?: string;
        macos?: string;
        linux?: string;
    };
    inputs?: { [key: string]: string };

    // Properties for 'zip'
    source?: string | string[];
    archive?: string;

    // Properties for 'stringManipulation'
    function?: string;
    input?: string;

    // Output handling
    output?: Output;

    // Execution behavior
    passTheResultToNextTask?: boolean;
    isOneShot?: boolean;
}

/**
 * Defines how the output of a task should be handled.
 */
export interface Output {
    mode: 'editor' | 'terminal' | 'file';

    // Properties for 'editor' mode
    title?: string;
    language?: string;

    // Properties for 'file' mode
    filePath?: string;
    content?: string;
    overwrite?: boolean;
}
