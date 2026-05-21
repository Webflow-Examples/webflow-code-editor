import * as vscode from 'vscode';

export class WebflowFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._emitter.event;

    private siteNameToId = new Map<string, string>();
    private pageKeyToId = new Map<string, string>();
    private accessToken: string | undefined;
    private onAuthFailure?: () => void;

    setToken(token: string): void {
        this.accessToken = token;
    }

    clearToken(): void {
        this.accessToken = undefined;
        this.siteNameToId.clear();
        this.pageKeyToId.clear();
    }

    setAuthFailureHandler(handler: () => void): void {
        this.onAuthFailure = handler;
    }

    registerSite(siteName: string, siteId: string): void {
        this.siteNameToId.set(siteName, siteId);
    }

    registerPage(siteName: string, pageKey: string, pageId: string): void {
        this.pageKeyToId.set(`${siteName}/${pageKey}`, pageId);
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const parts = uri.path.split('/').filter(Boolean);
        const last = parts[parts.length - 1] ?? '';
        const type = /\.html$/i.test(last) ? vscode.FileType.File : vscode.FileType.Directory;
        return { type, ctime: 0, mtime: 0, size: 0 };
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(): void {
        // no-op
    }

    private urlForUri(uri: vscode.Uri): string {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length === 2) {
            const [siteName, filename] = parts;
            const position = filename.replace(/\.html$/i, '').toLowerCase();
            const siteId = this.siteNameToId.get(siteName);
            if (!siteId) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            return `https://api.webflow.com/v2/sites/${siteId}/custom_code/freeform/${position}`;
        } else if (parts.length === 3) {
            const [siteName, pageKey, filename] = parts;
            const position = filename.replace(/\.html$/i, '').toLowerCase();
            const pageId = this.pageKeyToId.get(`${siteName}/${pageKey}`);
            if (!pageId) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            return `https://api.webflow.com/v2/pages/${pageId}/custom_code/freeform/${position}`;
        }
        throw vscode.FileSystemError.FileNotFound(uri);
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        if (!this.accessToken) {
            throw vscode.FileSystemError.NoPermissions('Not authenticated');
        }
        const url = this.urlForUri(uri);
        const req = await fetch(url, {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        if (req.status === 401) {
            this.onAuthFailure?.();
            throw vscode.FileSystemError.NoPermissions('Session expired');
        }
        const data: any = await req.json();
        const content: string = data.content ?? '';
        return new TextEncoder().encode(content);
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        if (!this.accessToken) {
            throw vscode.FileSystemError.NoPermissions('Not authenticated');
        }
        const url = this.urlForUri(uri);
        const text = new TextDecoder().decode(content);
        const req = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content: text })
        });
        if (req.status === 401) {
            this.onAuthFailure?.();
            throw vscode.FileSystemError.NoPermissions('Session expired');
        }
        if (!req.ok) {
            const errText = await req.text();
            throw vscode.FileSystemError.NoPermissions(`Save failed: ${req.status} ${errText}`);
        }
        vscode.window.setStatusBarMessage('Code block saved to site. Publish to make it live.', 10000);
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions('delete not supported');
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('rename not supported');
    }
}
