import request from '@/api/request';
import { unwrap } from '@/api/unwrap';

/**
 * Client-app catalog + scan — frontend API client ([DESIGN-ARCH-189], S1).
 *
 * The backend surface is served by the web backend at /api/client-apps
 * (routes/clientApps.js, admin-gated).
 *
 * Convention: the axios response interceptor returns the FULL axios response, so
 * `r.data` is the HTTP body `{ success, data }`. Every method here unwraps it
 * with the shared `unwrap` helper (the same one useUserGateway.js uses), so the
 * resolved value is the **inner** payload — `{ apps, count, ... }` for catalog,
 * `{ ok, ... }` for preview/configure. Without that, callers reading `r.apps` /
 * `r.ok` would silently get `undefined` (the envelope's outer layer), and the
 * whole page degrades to "no apps registered" instead of failing loudly.
 *
 * This slice is read-only by construction — the backend mounts no write route
 * (RUNTIME-010), so there is nothing here to call for "configure" or "restore".
 * The UI therefore shows those actions as unavailable rather than disabled.
 *
 * Scan results never carry a gateway token: `scanAll()` strips it before the
 * payload is built, so nothing sensitive crosses the wire (R2).
 */
export const clientAppsApi = {
  // The registry itself: { apps, count, updated, version }. No probing.
  catalog() {
    return request.get('/api/client-apps/catalog').then(unwrap);
  },
  // Probe this machine. `apps` narrows to a subset of appIds; omit for all.
  // Returns { gateway: { available, endpoint, reason }, apps: [...], count }.
  scan(apps) {
    return request
      .post('/api/client-apps/scan', apps && apps.length ? { apps } : {})
      .then(unwrap);
  },
  // Preview: what WOULD be written, no disk mutation. Cheap (path math only,
  // no probing), so the page asks it for every card to derive write posture.
  preview(appId, card) {
    return request.post('/api/client-apps/preview', { appId, card }).then(unwrap);
  },
  // Real write: backup -> write -> per-key read-back. 409 means "not applied"
  // (refused / backup failed / write failed) -- a business result, not a fault.
  configure(appId, { card, mode }) {
    return request.post('/api/client-apps/configure', { appId, card, mode }).then(unwrap);
  },
  // Reverse write back to the vendor's own config.
  restore(appId, target) {
    return request.post('/api/client-apps/restore', { appId, target }).then(unwrap);
  },
};
