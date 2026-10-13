/* pb-auth.js — the single seam between this app and PocketBase auth.
 *
 * Anyone can make an account and sign in; signed-in people get the new features and
 * can place stickers. Accounts live in this app's own `users` collection (email +
 * password), with no single sign-on. Sign-up goes through POST /api/cymbal/signup,
 * which always makes role "user"; the owner is the one account a superuser gave
 * role = admin in the PocketBase dashboard.
 *
 * Do not reimplement any of this in app code, and do not read `role` from anywhere
 * but the record: the users collection refuses any request that tries to set it
 * (pb_migrations/1756540000_identity.js, 1790467200_owner_password_auth.js,
 * 1791700000_member_accounts.js).
 *
 *   PBAuth.getClient()              PocketBase client, authenticated if signed in
 *   PBAuth.signIn(email, password)  password sign-in (returns a promise)
 *   PBAuth.signUp(email, password, name)  make an account and sign in to it
 *   PBAuth.requestReset(email)      email a "choose a new password" link
 *   PBAuth.confirmReset(token, password)  set the new password from that link
 *   PBAuth.signOut()                clear the local session
 *   PBAuth.user()                   the signed-in record, or null
 *   PBAuth.isSignedIn()
 *   PBAuth.isAdmin()                true when this person is an admin OF THIS APP
 *   PBAuth.onChange(fn)             called whenever sign-in state changes
 *
 * Sessions last seven days and are not renewed silently. onChange fires
 * with null the moment the session lapses; show the sign-in control at that point.
 *
 * Collection rules key on `@request.auth.id`. An app whose rules key on anything the
 * browser can choose has no access control, only decoration.
 */
const PBAuth = (() => {
  const client = new PocketBase(location.origin);
  const listeners = [];

  function notify() {
    const u = user();
    listeners.forEach((fn) => {
      try { fn(u); } catch (err) { console.error('[pb-auth] listener failed', err); }
    });
  }

  // The SDK marks a token invalid once its exp passes, but nothing tells the page
  // when that moment arrives — without this an app keeps rendering a signed-in UI
  // whose every API call now 401s. Fire onChange exactly when the session lapses so
  // the app can put a sign-in control on screen instead.
  let lapseTimer = null;

  function tokenExpiry() {
    const raw = client.authStore.token;
    if (!raw) return 0;
    try {
      let part = raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      part += '='.repeat((4 - (part.length % 4)) % 4);
      return (JSON.parse(atob(part)).exp || 0) * 1000;
    } catch (err) {
      return 0; // opaque token: no scheduling, the next 401 is the signal
    }
  }

  function scheduleLapse() {
    if (lapseTimer) { clearTimeout(lapseTimer); lapseTimer = null; }
    const at = tokenExpiry();
    if (!at) return;
    // +1s so the SDK's own validity check has certainly flipped when listeners run.
    const ms = at - Date.now() + 1000;
    if (ms <= 0) return;
    // setTimeout saturates above ~24.8 days; clamping keeps a bad exp from firing
    // the callback immediately in a loop.
    lapseTimer = setTimeout(onLapse, Math.min(ms, 2147483647));
  }

  function onLapse() {
    lapseTimer = null;
    notify(); // user() is null now: authStore.isValid went false with the exp
  }

  client.authStore.onChange(() => { scheduleLapse(); notify(); }, false);
  scheduleLapse();

  function user() {
    return client.authStore.isValid ? client.authStore.record : null;
  }

  function isSignedIn() {
    return !!user();
  }

  // Authoritative because only a superuser can set it: the collection's update rule
  // refuses any request body that carries `role`.
  function isAdmin() {
    const u = user();
    return !!u && u.role === 'admin';
  }

  // Rejects on a wrong email or password (PocketBase answers 400 without saying
  // which), so the caller can show one plain message.
  // Sign-up stores the email in lower case and PocketBase matches it exactly, so a
  // capital typed here (a phone's auto-capitalised first letter, say) is tried in
  // lower case first. As typed is the fallback, for an account made in the dashboard.
  async function signIn(email, password) {
    const typed = String(email || '').trim();
    const lower = typed.toLowerCase();
    try {
      await client.collection('users').authWithPassword(lower, String(password || ''));
    } catch (err) {
      if (lower === typed || (err && err.status !== 400)) throw err;
      await client.collection('users').authWithPassword(typed, String(password || ''));
    }
    return user();
  }

  // The new account comes back signed in, the same shape authWithPassword returns.
  async function signUp(email, password, name) {
    const res = await client.send('/api/cymbal/signup', {
      method: 'POST',
      body: { email: String(email || ''), password: String(password || ''), name: String(name || '') },
    });
    client.authStore.save(res.token, res.record);
    return user();
  }

  // Always resolves the same way whether or not the email has an account, so the page
  // can't be used to find out who has one.
  async function requestReset(email) {
    await client.collection('users').requestPasswordReset(String(email || '').trim().toLowerCase());
  }

  // The token comes from the emailed link. The new password doesn't sign anyone in.
  async function confirmReset(token, password) {
    await client.collection('users').confirmPasswordReset(String(token || ''), String(password || ''), String(password || ''));
  }

  function signOut() {
    client.authStore.clear();
  }

  function onChange(fn) {
    listeners.push(fn);
    fn(user());
    return () => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  function getClient() {
    return client;
  }

  return { getClient, signIn, signUp, requestReset, confirmReset, signOut, user, isSignedIn, isAdmin, onChange };
})();
