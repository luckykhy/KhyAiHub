import type { WebContents } from 'electron';
export interface PtyCreateResult {
    ok: boolean;
    id?: string;
    pid?: number;
    error?: string;
}
export declare function ptyCreate(opts: {
    cols?: number;
    rows?: number;
    cwd?: string;
}, sender: WebContents): Promise<PtyCreateResult>;
export declare function ptyWrite(id: string, data: string): void;
export declare function ptyResize(id: string, cols: number, rows: number): void;
export declare function ptyKill(id: string): void;
export declare function disposeAllPtys(): void;
//# sourceMappingURL=ptyHost.d.ts.map