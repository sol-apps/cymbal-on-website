/* pb-auth.js — the single seam between this app and PocketBase auth.
 *
 * Only the owner ever signs in, and only for the owner panel. The account lives in
 * this app's own `users` collection (email + password); there is no single sign-on
 * and no self-service sign-up — the owner's record is created in the PocketBase
 * dashboard, with role = admin set there by a superuser.
 *
 * Do not reimplement any of this in app code, and do not read `role` from anywhere
 * but the record: the users collection refuses any request that tries to set it
 * (pb_migrations/1756540000_identity.js, 1790467200_owner_password_auth.js).
 *
 *   PBAuth.getClient()              PocketBase client, authenticated if signed in
 *   PBAuth.signIn(email, password)  password sign-in (returns a promise)
 *   PBAuth.signOut()                clear the local session
 *   PBAuth.user()                   the signed-in record, or null
 *   PBAuth.isSignedIn()
 *   PBAuth.isAdmin()                true when this person is an admin OF THIS APP
 *   PBAuth.onChange(fn)             called whenever sign-in state changes
 *
 * Sessions are short (thirty minutes) and are not renewed silently. onChange fires
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
  async function signIn(email, password) {
    await client.collection('users').authWithPassword(String(email || ''), String(password || ''));
    return user();
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

  return { getClient, signIn, signOut, user, isSignedIn, isAdmin, onChange };
})();
