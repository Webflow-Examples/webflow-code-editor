import * as vscode from 'vscode';

interface Site {
    id: string;
    displayName: string;
}

interface Page {
    id: string;
    title?: string;
    slug?: string;
}

interface Script {
    id: string;
    location: string;
    version: string;
    attributes: object;
}

export class MyAuthTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private accessToken: string | undefined;
    private pageCache = new Map<string, Page[]>();
    private onAuthFailure?: () => void;

    private isLoggedIn: boolean = false;

    constructor() { }

    setAuthFailureHandler(handler: () => void): void {
        this.onAuthFailure = handler;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setToken(token: string) {
        this.accessToken = token;
        this.isLoggedIn = true;
        this.refresh();
    }

    // Call this to logout
    logout() {
        this.isLoggedIn = false;
        this.accessToken = undefined;
        this.pageCache.clear();
        this.refresh();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // 1. If user is NOT logged in, show the Login button
        if (!this.isLoggedIn) {
            const signInItem = new vscode.TreeItem('Sign in to Webflow', vscode.TreeItemCollapsibleState.None);
            
            // This command ID must match what we register in extension.ts
            signInItem.command = {
                command: 'webflow-code-editor.login',
                title: 'Sign In'
            };
            
            signInItem.iconPath = new vscode.ThemeIcon('sign-in');
            signInItem.tooltip = "Click here to log in";
            
            return [signInItem];
        }

        // 2. If user IS logged in, show the actual data
        if (element?.id === 'root') {
            let sites = await this.getSites();
            return sites.map(site => {
                const item = new vscode.TreeItem(site.displayName, vscode.TreeItemCollapsibleState.Collapsed);
                item.id = site.id;
                item.contextValue = 'site';
                return item;
            });
        } else if(element?.contextValue === 'site' && element.id) {
            const siteId = element.id;
            const siteName = element.label as string;
            const codeItems = ['HEAD', 'FOOTER'].map(name => {
                const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
                item.id = `${siteId}:${name}`;
                item.contextValue = 'codeNode';
                item.command = {
                    command: 'webflow-code-editor.codeNodeSelected',
                    title: 'Open code',
                    arguments: [siteId, siteName, name]
                };
                return item;
            });
            const pages = await this.getPages(siteId);
            const pageItems = pages.map(page => {
                const label = page.title || page.slug || page.id;
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
                item.id = `page:${page.id}`;
                item.contextValue = 'page';
                item.iconPath = new vscode.ThemeIcon('file');
                (item as any).siteName = siteName;
                (item as any).pageId = page.id;
                (item as any).pageKey = page.slug || page.id;
                (item as any).pageLabel = label;
                return item;
            });
            return [...codeItems, ...pageItems];
        } else if(element?.contextValue === 'page') {
            const e = element as any;
            return ['HEAD', 'FOOTER'].map(name => {
                const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
                item.id = `page:${e.pageId}:${name}`;
                item.contextValue = 'pageCodeNode';
                item.command = {
                    command: 'webflow-code-editor.pageCodeNodeSelected',
                    title: 'Open code',
                    arguments: [e.siteName, e.pageKey, e.pageId, name]
                };
                return item;
            });
        } else {
            // Root items for a logged-in user
            /*
            const userItem = new vscode.TreeItem('User: Raymond Camden', vscode.TreeItemCollapsibleState.None);
            userItem.iconPath = new vscode.ThemeIcon('person');
            userItem.description = 'Admin';
            */
            const dataItem = new vscode.TreeItem('My Sites', vscode.TreeItemCollapsibleState.Collapsed);
            dataItem.id = "root";

            
            return [dataItem];
        }
    }

    async getSites(): Promise<Site[]> {
        if (!this.accessToken) {
            return Promise.reject('Not authenticated');
        }

        let req = await fetch('https://api.webflow.com/v2/sites', {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`
            },
        });

        if (req.status === 401) {
            this.onAuthFailure?.();
            return [];
        }

        return ((await req.json()) as any).sites;

    }

    async getPages(siteId: string): Promise<Page[]> {
        const cached = this.pageCache.get(siteId);
        if (cached) {
            return cached;
        }
        if (!this.accessToken) {
            return Promise.reject('Not authenticated');
        }
        const all: Page[] = [];
        const limit = 100;
        let offset = 0;
        while (true) {
            const url = `https://api.webflow.com/v2/sites/${siteId}/pages?offset=${offset}&limit=${limit}`;
            const req = await fetch(url, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            if (req.status === 401) {
                this.onAuthFailure?.();
                return [];
            }
            const data: any = await req.json();
            const batch: Page[] = data.pages ?? [];
            all.push(...batch);
            const total: number | undefined = data.pagination?.total;
            if (batch.length === 0 || (total !== undefined && all.length >= total) || batch.length < limit) {
                break;
            }
            offset += batch.length;
        }
        this.pageCache.set(siteId, all);
        return all;
    }

    async getScripts(id:string): Promise<Script[]> {
        if (!this.accessToken) {
            return Promise.reject('Not authenticated');
        }
        console.log(`https://api.webflow.com/v2/sites/${id}/custom_code`);
        let req = await fetch(`https://api.webflow.com/v2/sites/${id}/custom_code/`, {
              headers: {
                'Authorization': `Bearer ${this.accessToken}`
            },
        });

        console.log(req.status);
        let test:any = await req.json();
        console.log(test);
        return [];
        return ((await req.json()) as any).scripts;

    }


}