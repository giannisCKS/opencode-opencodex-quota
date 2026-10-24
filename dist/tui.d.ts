/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { type RGBA } from "@opentui/core";
import { type JSX } from "@opentui/solid";
import type { QuotaSnapshot, QuotaWindow } from "./quota.js";
import { type QuotaSnapshotInput } from "./rpc.js";
/** A reading older than this is marked stale in the sidebar and the dialog. */
export declare const QUOTA_STALE_AFTER_MS: number;
/** The sidebar's width, and the width its quota text is laid out to. */
export declare const TUI_SIDEBAR_MAX_WIDTH = 36;
type DialogSize = "medium" | "large" | "xlarge";
type ThemeColor = string | RGBA;
type DialogTheme = {
    text: {
        base: ThemeColor;
        muted: ThemeColor;
        action: {
            primary: {
                focused: ThemeColor;
            };
        };
    };
    background: {
        action: {
            primary: {
                focused: ThemeColor;
            };
        };
    };
};
type TuiTheme = {
    text: {
        base: ThemeColor;
        muted: ThemeColor;
    };
    surface: (name: "dialog") => DialogTheme;
};
type KeymapCommand = {
    id?: string;
    title?: string;
    group?: string;
    palette?: boolean;
    bind?: string;
    slash?: {
        name: string;
        aliases?: string[];
        arguments?: true;
    };
    run?: () => boolean | void;
};
type KeymapLayer = {
    mode?: "global" | "modal";
    priority?: number;
    commands: KeymapCommand[];
};
type TuiContext = {
    location?: {
        directory: string;
    };
    client: {
        rpc: (definition: unknown) => {
            snapshot: (input: QuotaSnapshotInput, options: {
                location: {
                    directory: string;
                };
                signal: AbortSignal;
            }) => Promise<QuotaSnapshot>;
        };
    };
    theme: TuiTheme;
    keymap?: {
        layer: (build: () => KeymapLayer) => void;
    };
    data: {
        location?: {
            default: () => {
                directory: string;
            };
        };
    };
    ui: {
        slot: (claim: {
            append: "sidebar.content";
            render: (props: {
                sessionID: string;
            }) => JSX.Element;
        }) => () => void;
        dialog?: {
            show: (render: () => JSX.Element, onClose?: () => void) => void;
            clear: () => void;
            set: (options: {
                size: DialogSize;
            }) => void;
        };
    };
};
export type QuotaLoader = (signal: AbortSignal) => Promise<QuotaSnapshot>;
export type QuotaStoreOptions = {
    pollIntervalMs?: number;
    requestTimeoutMs?: number;
    now?: () => number;
};
export type QuotaStore = {
    snapshot: () => QuotaSnapshot | undefined;
    failure: () => string | undefined;
    loading: () => boolean;
    lastLoadedAt: () => number | undefined;
    refresh: () => void;
    dispose: () => void;
};
export type QuotaTone = "title" | "text" | "muted" | "warning";
export type QuotaRow = {
    text: string;
    tone: QuotaTone;
};
export type QuotaReading = {
    snapshot?: QuotaSnapshot;
    failure?: string;
    loading: boolean;
    lastLoadedAt?: number;
    now: number;
};
/** Compact duration: 42s, 7m, 3h, 2d. */
export declare function formatDuration(value: number): string;
/** A human age for an ISO timestamp: just now, 7m ago, 3h ago. */
export declare function ageLabel(value: string | undefined, now: number): string | undefined;
/**
 * Compact reset countdown. Minutes under one hour (rounded up, at least 1m),
 * hours under one day, then whole days. A due or past reset reads due.
 */
export declare function formatCountdown(value: number): string;
/** Countdown for a timestamp, or ?d when no timestamp exists. */
export declare function formatResetCountdown(value: string | undefined, now: number): string;
/** Remaining quota, or an explicit unknown. A missing percent is never shown as zero. */
export declare function remainingLabel(window: QuotaWindow): string;
/** The bar width used in the sidebar and the dialog. */
export declare const QUOTA_BAR_WIDTH = 10;
/**
 * A compact remaining-quota bar. A missing percent returns undefined, so an
 * unknown value is never drawn as an empty or zero bar.
 */
export declare function remainingBar(window: QuotaWindow, width?: number): string | undefined;
/** The sidebar's one-line status. A null status means the rows carry the state. */
export declare function quotaSidebarStatus(input: QuotaReading): string | undefined;
/** Compact sidebar rows. OpenAI keeps pooled windows only; other providers keep accounts. */
export declare function quotaSidebarRows(input: QuotaReading): QuotaRow[];
/** The full, scrollable dialog rows. No model request is made to build them. */
export declare function quotaDialogRows(input: QuotaReading): QuotaRow[];
/** The dialog subtitle: the pool's age, error state, and provider count. */
export declare function quotaDialogSubtitle(input: QuotaReading): string;
/**
 * One snapshot store for the whole plugin. It polls slowly, collapses refreshes
 * that arrive during a load, keeps the last reading after a failure, and stops
 * its timer and in-flight request on disposal.
 */
export declare function createQuotaStore(load: QuotaLoader, options?: QuotaStoreOptions): QuotaStore;
/** Opens the quota dialog for the shared store and asks for one fresh reading. */
export declare function showQuotaDialog(context: TuiContext, store: QuotaStore, size?: DialogSize): void;
declare const plugin: Plugin.Definition;
export default plugin;
//# sourceMappingURL=tui.d.ts.map