/** Shared desktop/mobile page for repository connections on an existing Vitre
 * account. This page never creates or merges Vitre accounts by email. */
export function githubAccountPage(publishableKey: string): string {
  const host = atob(publishableKey.replace(/^pk_(test|live)_/, "")).replace(/\$$/, "");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("Invalid Clerk frontend domain");
  const key = publishableKey.replace(/[^a-zA-Z0-9_=-]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub accounts · Vitre</title>
<style>
:root{color-scheme:light dark;--bg:#fcfcfc;--fg:#27272a;--muted:#71717b;--border:#e4e4e7;--card:#fff;--hover:#f4f4f5;--primary:#1b4ed8}
@media(prefers-color-scheme:dark){:root{--bg:#000;--fg:#f1f3f7;--muted:#a3a3a3;--border:#ffffff14;--card:#181818;--hover:#191a1d;--primary:#366ffb}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px "DM Sans",system-ui,sans-serif}main{max-width:576px;margin:72px auto;padding:24px}header{margin-bottom:24px}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{color:var(--muted);line-height:1.5;margin:8px 0}section{border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--card)}.row{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}.identity{flex:1;min-width:0;overflow-wrap:anywhere}.identity small{display:block;color:var(--muted);margin-top:4px}button{font:inherit;color:inherit;background:transparent;border:1px solid var(--border);border-radius:8px;padding:8px 12px;cursor:pointer}button:hover{background:var(--hover)}button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}button:disabled{opacity:.5;cursor:wait}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}#status{min-height:24px}#error{color:#d14a57}#auth{margin-top:16px}#connection:empty{display:none}#connection{margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}.device-code{display:block;font:600 24px ui-monospace,monospace;letter-spacing:3px;margin:16px 0}a{color:var(--primary)}@media(max-width:600px){main{margin:24px auto;padding:16px}}
</style>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${key}" src="https://${host}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${key}" src="https://${host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
</head><body><main><header><p>Vitre account</p><h1>GitHub accounts</h1><p>Connect personal and work GitHub accounts for repository access. Your Vitre sign-in stays separate.</p></header><section><div id="accounts"></div><p id="status" role="status">Loading your account…</p><p id="error" role="alert"></p><div class="actions" id="actions"></div><div id="auth"></div><div id="connection" aria-live="polite"></div></section><p>Private repositories also need access through the Vitre GitHub App. Your organization may require approval.</p></main>
<script>
window.addEventListener('load', async () => {
  const status = document.getElementById('status');
  const error = document.getElementById('error');
  const rows = document.getElementById('accounts');
  const actions = document.getElementById('actions');
  const connection = document.getElementById('connection');
  const expected = new URL(location.href).searchParams.get('user');
  const returnUrl = new URL('/account/github', location.origin);
  if (expected) returnUrl.searchParams.set('user', expected);
  const storageKey = 'vitre.github.connection.' + expected;
  let timer;
  let expiresAt = Date.now() + 15 * 60_000;
  let retryDelay = 5000;
  const currentAccount = () => expected && Clerk.user?.id === expected;
  const stopPolling = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const request = async (path, body) => {
    if (!currentAccount()) throw new Error('Sign in to the Vitre account that opened this page.');
    const session = Clerk.session?.id;
    const token = await Clerk.session?.getToken({ template: 't3-relay' });
    if (!token || !currentAccount() || Clerk.session?.id !== session)
      throw new Error('Your session changed. Reload this page and sign in again.');
    let response;
    try {
      response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw Object.assign(new Error('Your connection was interrupted. Try again.'), { retryable: true });
    }
    const value = await response.json().catch(() => null);
    const retryable = response.status === 429 || response.status >= 500 || value?.code === 'concurrent_update';
    if (!response.ok || !value) throw Object.assign(
      new Error(value?.message || 'This operation could not complete. Try again.'), { retryable },
    );
    return value;
  };
  const button = (label, action, requireAccount = true) => {
    const control = document.createElement('button');
    control.textContent = label;
    control.onclick = async () => {
      if (requireAccount && !currentAccount()) { await render(); return; }
      control.disabled = true; error.textContent = '';
      try { await action(); }
      catch (failure) {
        error.textContent = failure.errors?.[0]?.longMessage || failure.message || 'Could not update this account.';
      } finally { control.disabled = false; }
    };
    return control;
  };
  const redirect = account => {
    const url = account.verification?.externalVerificationRedirectURL;
    if (url) location.assign(url.href || String(url));
  };
  const poll = async requestId => {
    stopPolling();
    if (!currentAccount()) return;
    try {
      const value = await request('/v1/cloud/github/connections', { type: 'poll', requestId });
      if (!currentAccount() || sessionStorage.getItem(storageKey) !== requestId) return;
      await showConnection(value);
    } catch (failure) {
      if (sessionStorage.getItem(storageKey) !== requestId) return;
      if (failure.retryable && currentAccount() && Date.now() < expiresAt) {
        error.textContent = 'Connection interrupted. Retrying automatically; you can finish authorizing on GitHub.';
        timer = setTimeout(() => poll(requestId), retryDelay);
        retryDelay = Math.min(30000, retryDelay * 2);
        return;
      }
      sessionStorage.removeItem(storageKey);
      connection.replaceChildren();
      error.textContent = failure.message || 'The connection expired. Start a new one.';
    }
  };
  const showConnection = async value => {
    error.textContent = ''; retryDelay = 5000;
    expiresAt = value.expiresAt || Date.now() + 15 * 60_000;
    connection.replaceChildren();
    if (value.status === 'connected') {
      stopPolling(); sessionStorage.removeItem(storageKey);
      await render();
      status.textContent = '@' + value.account.login + ' is connected for repository access.';
      return;
    }
    const description = document.createElement('p');
    description.textContent = value.userCode
      ? 'Enter this code on GitHub. Choose the account you want to connect and review its permissions.'
      : 'Starting GitHub authorization…';
    connection.append(description);
    if (value.userCode) {
      const code = document.createElement('strong');
      code.className = 'device-code'; code.textContent = value.userCode;
      const link = document.createElement('a');
      link.href = 'https://github.com/login/device'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = 'Continue on GitHub';
      const note = document.createElement('p');
      note.textContent = 'This page updates after you authorize. The code expires in a few minutes.';
      connection.append(code, link, note);
    }
    sessionStorage.setItem(storageKey, value.requestId);
    timer = setTimeout(() => poll(value.requestId), Math.max(1000, value.pollAfterMs || 5000));
  };
  const render = async () => {
    rows.replaceChildren(); actions.replaceChildren();
    if (!expected) { status.textContent = 'Open this page from GitHub accounts in Vitre Settings.'; return; }
    if (!Clerk.user) {
      stopPolling();
      status.textContent = 'Sign in to your existing Vitre account to manage repository connections.';
      Clerk.mountSignIn(document.getElementById('auth'), { forceRedirectUrl: returnUrl.href, signUpForceRedirectUrl: returnUrl.href });
      return;
    }
    if (!currentAccount()) {
      stopPolling(); connection.replaceChildren();
      status.textContent = 'This browser is signed in to a different Vitre account. Switch to the account you opened from Vitre before linking.';
      actions.append(button('Switch account', () => Clerk.signOut({ redirectUrl: returnUrl.href }), false));
      return;
    }
    const overview = await request('/v1/cloud');
    if (!currentAccount()) return;
    const accounts = overview.githubAccounts || [];
    status.textContent = accounts.length ? 'Available on desktop and mobile when you sign in to this Vitre account.' : 'Connect a GitHub account for repository access.';
    for (const account of accounts) {
      const row = document.createElement('div'); row.className = 'row';
      const identity = document.createElement('div'); identity.className = 'identity';
      identity.textContent = '@' + account.login;
      const state = document.createElement('small');
      const repositoryConnection = account.id.startsWith('gha_');
      state.textContent = (repositoryConnection ? 'Repository access' : 'Vitre sign-in') + ' · ' + (account.state === 'connected' ? 'Connected' : 'Reconnect needed');
      identity.append(state); row.append(identity);
      if (repositoryConnection) {
        row.append(button('Disconnect', async () => {
          if (!confirm('Disconnect @' + account.login + ' from repository access? Your Vitre sign-in and saved conversations stay available.')) return;
          await request('/v1/cloud/github/connections', { type: 'disconnect', accountId: account.id });
          await render();
        }));
      } else {
        const identity = Clerk.user.externalAccounts.find(item => item.id === account.id);
        if (identity) row.append(button('Reconnect', async () => redirect(await identity.reauthorize({
          redirectUrl: returnUrl.href, additionalScopes: ['repo'],
        }))));
      }
      rows.append(row);
    }
    actions.append(button('Connect GitHub account', async () => {
      stopPolling();
      const requestId = sessionStorage.getItem(storageKey) || crypto.randomUUID();
      sessionStorage.setItem(storageKey, requestId);
      await showConnection(await request('/v1/cloud/github/connections', { type: 'start', requestId }));
    }));
    actions.append(button('Refresh', async () => {
      await Clerk.user.reload();
      await request('/v1/cloud/commands', { type: 'github.refresh', idempotencyKey: crypto.randomUUID() });
      await render();
    }));
  };
  window.addEventListener('beforeunload', stopPolling);
  try {
    await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    await render();
    const pending = sessionStorage.getItem(storageKey);
    if (pending && currentAccount()) await poll(pending);
  } catch (failure) {
    status.textContent = 'Account services could not load.';
    error.textContent = failure.message || 'Check your connection and reload this page.';
  }
});
</script></body></html>`;
}
