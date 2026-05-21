import * as vscode from 'vscode';
import { MyAuthTreeProvider } from './TreeDataProvider';
import { WebflowFileSystemProvider } from './WebflowFileSystemProvider';

const CLIENT_ID = 'e6dad264f35b9810e0ac3253eb3ea2492cfb0f4d085fba735324eb6ad66faa1e';
const OAUTH_CALLBACK_URL = 'https://vsccodeeditorextension.webflow.new/oauth/callback';
const SECRET_KEY = 'webflow-auth';

interface StoredAuth {
    token: string;
    expiresAt?: number;
}

async function loadStoredAuth(context: vscode.ExtensionContext): Promise<StoredAuth | undefined> {
    const raw = await context.secrets.get(SECRET_KEY);
    if (!raw) {
        return undefined;
    }
    try {
        const parsed: StoredAuth = JSON.parse(raw);
        if (parsed.expiresAt && parsed.expiresAt <= Date.now()) {
            await context.secrets.delete(SECRET_KEY);
            return undefined;
        }
        return parsed;
    } catch {
        await context.secrets.delete(SECRET_KEY);
        return undefined;
    }
}

async function storeAuth(context: vscode.ExtensionContext, token: string, expiresIn?: number): Promise<void> {
    const stored: StoredAuth = {
        token,
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined
    };
    await context.secrets.store(SECRET_KEY, JSON.stringify(stored));
}

async function clearAuth(context: vscode.ExtensionContext, provider: MyAuthTreeProvider, fs: WebflowFileSystemProvider): Promise<void> {
    const existing = await context.secrets.get(SECRET_KEY);
    if (!existing) {
        return;
    }
    await context.secrets.delete(SECRET_KEY);
    provider.logout();
    fs.clearToken();
    await closeWebflowTabs();
    vscode.window.showWarningMessage('Webflow session expired. Please log in again.');
}

export async function activate(context: vscode.ExtensionContext) {

    const myTreeProvider = new MyAuthTreeProvider();
    const webflowFs = new WebflowFileSystemProvider();

    const handleAuthFailure = () => { void clearAuth(context, myTreeProvider, webflowFs); };
    myTreeProvider.setAuthFailureHandler(handleAuthFailure);
    webflowFs.setAuthFailureHandler(handleAuthFailure);

    const stored = await loadStoredAuth(context);
    if (stored) {
        myTreeProvider.setToken(stored.token);
        webflowFs.setToken(stored.token);
    }

    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('webflow', webflowFs, { isCaseSensitive: true })
    );

    // 1. Register Tree View
    vscode.window.registerTreeDataProvider('my-auth-tree-view', myTreeProvider);

    // 2. Handle the OAuth Callback
    // The serverless function at OAUTH_CALLBACK_URL exchanges the code for a token
    // and redirects here with access_token (or error) already in the query.
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            async handleUri(uri: vscode.Uri) {
                if (uri.path !== '/did-authenticate') {
                    return;
                }
                const query = new URLSearchParams(uri.query);

                const error = query.get('error');
                if (error) {
                    const description = query.get('error_description');
                    vscode.window.showErrorMessage(
                        `Login failed: ${error}${description ? ` — ${description}` : ''}`
                    );
                    return;
                }

                const accessToken = query.get('access_token');
                if (!accessToken) {
                    vscode.window.showErrorMessage('Login failed: no access token returned.');
                    return;
                }

                const expiresInNum = Number(query.get('expires_in'));
                const expiresIn = Number.isFinite(expiresInNum) && expiresInNum > 0 ? expiresInNum : undefined;

                await storeAuth(context, accessToken, expiresIn);
                myTreeProvider.setToken(accessToken);
                webflowFs.setToken(accessToken);
                vscode.window.showInformationMessage('Login successful!');
            }
        })
    );

    // 3. Register the Login Command
    context.subscriptions.push(vscode.commands.registerCommand('webflow-code-editor.login', async () => {
        loginToWebflow();
    }));

    // 4. Handle clicks on HEAD / FOOTER nodes
    context.subscriptions.push(vscode.commands.registerCommand('webflow-code-editor.codeNodeSelected', async (siteId: string, siteName: string, nodeName: string) => {
        try {
            webflowFs.registerSite(siteName, siteId);
            const uri = vscode.Uri.from({
                scheme: 'webflow',
                path: `/${siteName}/${nodeName}.html`
            });
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.languages.setTextDocumentLanguage(doc, 'html');
            await vscode.window.showTextDocument(doc);
        } catch (err) {
            console.error(`Failed to open ${nodeName} for ${siteName}:`, err);
            vscode.window.showErrorMessage(`Failed to load ${nodeName}: ${err}`);
        }
    }));

    // 5. Handle clicks on HEAD / FOOTER nodes under a page
    context.subscriptions.push(vscode.commands.registerCommand('webflow-code-editor.pageCodeNodeSelected', async (siteName: string, pageKey: string, pageId: string, nodeName: string) => {
        try {
            webflowFs.registerPage(siteName, pageKey, pageId);
            const uri = vscode.Uri.from({
                scheme: 'webflow',
                path: `/${siteName}/${pageKey}/${nodeName}.html`
            });
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.languages.setTextDocumentLanguage(doc, 'html');
            await vscode.window.showTextDocument(doc);
        } catch (err) {
            console.error(`Failed to open ${nodeName} for ${siteName}/${pageKey}:`, err);
            vscode.window.showErrorMessage(`Failed to load ${nodeName}: ${err}`);
        }
    }));

    // Drop any webflow: tabs that were restored from a prior session — they can't
    // load until the user authenticates again.
    closeWebflowTabs();
}

async function closeWebflowTabs(): Promise<void> {
    const toClose: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputText && input.uri.scheme === 'webflow' && !tab.isDirty) {
                toClose.push(tab);
            }
        }
    }
    if (toClose.length > 0) {
        await vscode.window.tabGroups.close(toClose);
    }
}

async function loginToWebflow() {
    // VS Code deep link the serverless callback will redirect us back to.
    const callbackUri = await vscode.env.asExternalUri(
        vscode.Uri.parse(`${vscode.env.uriScheme}://raymondcamden.webflow-code-editor/did-authenticate`)
    );

    // Webflow redirects to OAUTH_CALLBACK_URL with ?code&state; the function
    // exchanges the code (it holds CLIENT_SECRET) and 302s to `state` with the token.
    const searchParams = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: 'custom_code:read custom_code:write pages:read pages:write sites:read sites:write',
        redirect_url: OAUTH_CALLBACK_URL,
        state: callbackUri.toString(true)
    });

    const uri = vscode.Uri.parse(`https://webflow.com/oauth/authorize?${searchParams.toString()}`);
    vscode.env.openExternal(uri);
}