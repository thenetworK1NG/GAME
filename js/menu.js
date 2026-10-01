/**
 * Menu button, install flow, and service worker registration.
 *
 * Kept out of game.js on purpose: none of this needs the renderer, so the game
 * still boots if this module is absent, and a syntax error here cannot take the
 * plushie down with it.
 */

const menuButton = document.getElementById('menu-button');
const menu = document.getElementById('menu');
const backdrop = document.getElementById('menu-backdrop');
const installRow = document.getElementById('install-row');
const installButton = document.getElementById('install');
const installNote = document.getElementById('install-note');

function setMenu(open) {
  menu.classList.toggle('open', open);
  // Toggled together rather than by a second call site, so the dimmed backdrop
  // can never be left behind on a closed menu.
  backdrop.classList.toggle('open', open);
  menuButton.setAttribute('aria-expanded', String(open));
}

// --------------------------------------------------------------- open/close

menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  setMenu(!menu.classList.contains('open'));
});

// Tapping the dimmed backdrop closes it. Bound on the backdrop itself rather
// than the sheet, so a drag that starts inside the menu does not dismiss it.
backdrop.addEventListener('click', () => setMenu(false));

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!menu.classList.contains('open')) return;
  setMenu(false);
  menuButton.focus();
});

// Close after any navigation-ish gesture, so a tap elsewhere never leaves the
// sheet hanging over the game.
document.addEventListener('pointerdown', (event) => {
  if (!menu.classList.contains('open')) return;
  if (menu.contains(event.target) || menuButton.contains(event.target)) return;
  setMenu(false);
}, { passive: true });

// ------------------------------------------------------------ install flow

let deferredPrompt = null;

// The browser only fires this when the app meets its install criteria, and
// refuses to fire it again once dismissed. So the menu has to work without it,
// which is why the state is derived from all four signals rather than from this
// event alone.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  renderInstallState();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  renderInstallState();
});

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true
  );
}

function renderInstallState() {
  if (!installRow) return;

  if (isStandalone()) {
    installRow.hidden = true;
    return;
  }
  installRow.hidden = false;

  if (deferredPrompt) {
    installButton.disabled = false;
    installButton.textContent = 'Install';
    installNote.hidden = true;
    return;
  }

  // No prompt available. Either iOS, which has no install API at all, or the
  // criteria are not met yet (no service worker control, no engagement).
  const iOS = /iPad|iPhone|iPod/.test(window.navigator.userAgent);
  const iPadOS = window.navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  if (iOS || iPadOS) {
    installButton.disabled = true;
    installButton.textContent = 'Install';
    installNote.hidden = false;
    installNote.textContent = 'Tap Share, then “Add to Home Screen”.';
    return;
  }

  installButton.disabled = true;
  installButton.textContent = 'Install';
  installNote.hidden = false;
  installNote.textContent = 'Use your browser menu and choose “Install app” or “Add to Home screen”.';
}

installButton?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  const prompt = deferredPrompt;
  // Cleared up front: Chrome throws if prompt() is called twice, and the event
  // is single-use regardless.
  deferredPrompt = null;
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch {
    // Dismissed or blocked. Falls through to the browser-menu instructions.
  }
  renderInstallState();
});

// ------------------------------------------------------------ service worker

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// has no service worker support, and the worker needs a real origin.
  if (location.protocol === 'file:') return;

  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch {
    // Offline support is a bonus; the game runs fine without it.
  }
}

window.addEventListener('load', () => {
  registerServiceWorker();
  renderInstallState();
  // The prompt can arrive after load, but re-checking is cheap and covers the
  // case where the page was restored from bfcache.
  setTimeout(renderInstallState, 1500);
});

// A newly-installed worker sits in the waiting state until every tab using the
// old one closes, then claims control and this fires. Reloading at that moment is
// what makes the update actually land: without it the player keeps running
// yesterday's code until they manually refresh.
//
// sessionStorage guards the reload against a loop, since a reload re-fires
// controllerchange on a cold start.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    let reloaded = false;
    try {
      reloaded = window.sessionStorage.getItem('plushie:sw-reload') === '1';
      window.sessionStorage.setItem('plushie:sw-reload', '1');
    } catch {
      // Private mode can refuse storage. Reloading once anyway is still better
      // than silently running a stale build, and the flag is only set on the
      // reload path, so a throw here cannot produce a loop.
    }
    if (!reloaded) window.location.reload();
  });
}