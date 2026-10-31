/** Shared desktop/mobile account page. Clerk verifies new identities on the
 * existing user; this page never creates or merges Vitre accounts by email. */
export function githubAccountPage(publishableKey: string): string {
  const host = atob(publishableKey.replace(/^pk_(test|live)_/, "")).replace(/\$$/, "");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("Invalid Clerk frontend domain");
  const key = publishableKey.replace(/[^a-zA-Z0-9_=-]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub accounts · Vitre</title>
<style>
:root{color-scheme:light dark;--bg:#fcfcfc;--fg:#27272a;--muted:#71717b;--border:#e4e4e7;--card:#fff;--hover:#f4f4f5;--primary:#1b4ed8}
@media(prefers-color-scheme:dark){:root{--bg:#000;--fg:#f1f3f7;--muted:#a3a3a3;--border:#ffffff14;--card:#181818;--hover:#191a1d;--primary:#366ffb}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px "DM Sans",system-ui,sans-serif}main{max-width:576px;margin:72px auto;padding:24px}header{margin-bottom:24px}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{color:var(--muted);line-height:1.5;margin:8px 0}section{border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--card)}.row{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}.identity{flex:1;min-width:0;overflow-wrap:anywhere}.identity small{display:block;color:var(--muted);margin-top:4px}button{font:inherit;color:inherit;background:transparent;border:1px solid var(--border);border-radius:8px;padding:8px 12px;cursor:pointer}button:hover{background:var(--hover)}button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}button:disabled{opacity:.5;cursor:wait}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}#status{min-height:24px}#error{color:#d14a57}#auth{margin-top:16px}@media(max-width:600px){main{margin:24px auto;padding:16px}}
</style>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${key}" src="https://${host}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${key}" src="https://${host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
</head><body><main><header><p>Vitre account</p><h1>GitHub accounts</h1><p>Link personal and work accounts once. Sign in to Vitre with either account to use your repositories on desktop and mobile.</p></header><section><div id="accounts"></div><p id="status" role="status">Loading your account…</p><p id="error" role="alert"></p><div class="actions" id="actions"></div><div id="auth"></div></section><p>Private repositories also need access through the Vitre GitHub App. Your organization may require approval.</p></main>
<script>
window.addEventListener('load', async () => {
  const status = document.getElementById('status');
  const error = document.getElementById('error');
  const rows = document.getElementById('accounts');
  const actions = document.getElementById('actions');
  const expected = new URL(location.href).searchParams.get('user');
  const returnUrl = new URL('/account/github', location.origin);
  if (expected) returnUrl.searchParams.set('user', expected);
  const signOut = () => Clerk.signOut({ redirectUrl: returnUrl.href });
  const button = (label, action, requireAccount = true) => {
    const control = document.createElement('button');
    control.textContent = label;
    control.onclick = async () => {
      if (requireAccount && (!expected || Clerk.user?.id !== expected)) { render(); return; }
      control.disabled = true;
      error.textContent = '';
      try { await action(); }
      catch (failure) {
        error.textContent = failure.errors?.[0]?.longMessage || 'Could not update this account. Try again.';
        if (failure.errors?.some(item => item.code === 'session_reverification_required'))
          actions.append(button('Sign in again', signOut, false));
      } finally { control.disabled = false; }
    };
    return control;
  };
  const redirect = account => {
    const url = account.verification?.externalVerificationRedirectURL;
    if (url) location.assign(url.href || String(url));
    else render();
  };
  const render = () => {
    rows.replaceChildren();
    actions.replaceChildren();
    if (!expected) {
      status.textContent = 'Open this page from GitHub accounts in Vitre Settings.';
      return;
    }
    if (!Clerk.user) {
      status.textContent = 'Sign in to your existing Vitre account to link another GitHub account.';
      Clerk.mountSignIn(document.getElementById('auth'), {
        forceRedirectUrl: returnUrl.href, signUpForceRedirectUrl: returnUrl.href,
      });
      return;
    }
    if (Clerk.user.id !== expected) {
      status.textContent = 'This browser is signed in to a different Vitre account. Switch to the account you opened from Vitre before linking.';
      actions.append(button('Switch account', signOut, false));
      return;
    }
    const accounts = Clerk.user.externalAccounts.filter(account => account.provider === 'github' || account.provider === 'oauth_github');
    status.textContent = accounts.length ? 'These accounts are available wherever you sign in to Vitre.' : 'No GitHub accounts linked yet.';
    for (const account of accounts) {
      const row = document.createElement('div'); row.className = 'row';
      const identity = document.createElement('div'); identity.className = 'identity';
      identity.textContent = '@' + (account.username || account.accountIdentifier());
      const state = document.createElement('small');
      state.textContent = account.verification?.status === 'verified' ? 'Connected' : 'Needs sign-in';
      identity.append(state);
      row.append(identity, button('Reconnect', async () => redirect(await account.reauthorize({
        redirectUrl: returnUrl.href, additionalScopes: ['repo'],
      }))));
      row.append(button('Remove', async () => {
        if (confirm('Remove this GitHub account from Vitre? You will no longer be able to sign in with it or start new repository operations through it.')) {
          await account.destroy(); await Clerk.user.reload(); render();
        }
      }));
      rows.append(row);
      if (account.verification?.error?.longMessage) error.textContent = account.verification.error.longMessage;
    }
    actions.append(button('Link another GitHub account', async () => redirect(await Clerk.user.createExternalAccount({
      strategy: 'oauth_github', oidcPrompt: 'select_account', redirectUrl: returnUrl.href, additionalScopes: ['repo'],
    }))));
    actions.append(button('Refresh', async () => { await Clerk.user.reload(); render(); }));
  };
  try {
    await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    render();
  } catch {
    status.textContent = 'Account services could not load. Check your connection and reload this page.';
  }
});
</script></body></html>`;
}
