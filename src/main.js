/* ============================================================
   REGOLITH — The Silence at Anaxagoras
   Bootstrap, loading, menus, and the frame loop.
   ============================================================ */
import * as THREE from 'three';
import { Engine, QUALITY } from './core/engine.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { Save } from './core/save.js';
import { BackendAccessError, createBrowserBackend } from './services/backend.js';
import { clamp, sstep, lerp } from './core/rng.js';
import { bakeTerrain, Terrain, PLAYABLE_R } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { Props, HOME } from './world/props.js';
import { Dust } from './world/dust.js';
import { makeEarthTextures, makeMoonAlbedo } from './world/textures.js';
import { Rover, DRIVE, EARTH_RTT } from './game/rover.js';
import { CameraRig, CAM } from './game/camera.js';
import { Game, STATION, MASSIF, OPS } from './game/gameplay.js';
import { HUD } from './ui/hud.js';
import { MISSIONS } from './game/lore.js';

const $ = (id) => document.getElementById(id);
const ST = { BOOT: 0, MENU: 1, PLAY: 2, PAUSE: 3, CODEX: 4, HELP: 5, CARD: 6 };

const App = {
  state: ST.BOOT,
  settings: Object.assign({
    quality: guessQuality(), fov: 58, sens: 1.0, invertY: false,
    bloom: true, grain: 1.0, aberr: 1.0, stars: 1.0,
    volSfx: 0.8, volMusic: 0.5, music: true, tc: true, hudOn: true, autoCentre: 1,
    hudScale: 1, realistic: false, comms: false
  }, Save.settings()),
  elapsed: 0, sunAz: 4.35, paused: false
};

const backend = createBrowserBackend({
  onStatus: showBackendStatus,
  onConflict: promptCloudConflict
});
App.backend = backend;

function guessQuality() {
  // deviceMemory is Chromium-only, so on Safari and Firefox the core count has
  // to carry the guess by itself rather than silently reading as 4 GB.
  const mem = navigator.deviceMemory || 0;
  const cores = navigator.hardwareConcurrency || 4;
  let tier;
  if (cores >= 8 && (mem === 0 || mem >= 8)) tier = 2;
  else if (cores >= 6 || mem >= 4) tier = 1;
  else tier = 0;
  /* A coarse pointer means a touch screen, not a slow chip — an iPad Pro and a
     touchscreen laptop both report it. This used to return LOW outright, which
     pinned every tablet to seven clipmap levels and a 0.5 m excavation grid no
     matter what the player picked. Take one tier off for the thinner thermal
     budget instead, and let the frame governor do the rest. */
  if (matchMedia('(pointer: coarse)').matches) tier = Math.max(0, tier - 1);
  return ['low', 'medium', 'high'][tier];
}

/* ============================================================
   LOADING
   ============================================================ */
const bar = $('loadfill'), loadtext = $('loadtext');
function progress(p, msg) {
  bar.style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%';
  if (msg) loadtext.textContent = msg;
}

function showBackendStatus(message) {
  const el = $('backendStatus');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function promptCloudConflict(details = {}) {
  const overlay = $('cloudConflict');
  const detail = $('cloudConflictDetail');
  if (details.serverVersion) detail.textContent =
    `The cloud copy is version ${details.serverVersion}. Your local save remains safe until you choose.`;
  overlay.classList.remove('hidden');
  return new Promise((resolve) => {
    const finish = (choice) => {
      overlay.classList.add('hidden');
      $('cloudUseServer').onclick = null;
      $('cloudUseClient').onclick = null;
      resolve(choice);
    };
    $('cloudUseServer').onclick = () => finish('keep_server');
    $('cloudUseClient').onclick = () => finish('use_client');
  });
}

/* Optional imagery. The game generates everything it needs, so the repo ships
   with no third-party assets.

   Off by default, and deliberately not auto-probing: attempting the four loads
   unconditionally cost every player four 404s in the console on every single
   load, to support a folder that is empty in every copy of this repo. Drop real
   equirectangular maps into assets/tex/ and flip this to true. */
const USE_DISK_TEX = false;
const OPTIONAL_TEX = [
  ['earthDay', 'assets/tex/earth-2k.jpg', true],
  ['earthNight', 'assets/tex/earth-night-2k.jpg', true],
  ['earthClouds', 'assets/tex/earth-clouds-2k.jpg', false],
  ['moonAlbedo', 'assets/tex/moon-2k.jpg', true]
];

function loadTextures() {
  if (!USE_DISK_TEX) return Promise.resolve({});
  const L = new THREE.TextureLoader();
  const one = ([key, url, srgb]) => new Promise((resolve) => {
    L.load(url,
      (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = 8;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        resolve([key, t]);
      },
      undefined,
      () => resolve([key, null])                 // absent is the normal case
    );
  });
  return Promise.all(OPTIONAL_TEX.map(one)).then((pairs) => {
    const tex = {};
    for (const [k, t] of pairs) if (t) tex[k] = t;
    return tex;
  });
}

async function boot() {
  progress(0.005, 'verifying online services…');
  await backend.initialize();
  await backend.syncInitialSave(Save);
  Save.setSyncHandler((data, meta) => backend.queueCloudSave(data, meta));

  progress(0.01, 'initialising telemetry link…');

  const engine = new Engine($('stage'), App.settings.quality);
  App.engine = engine;
  await new Promise(r => setTimeout(r, 30));

  /* ---- bake the basin, yielding to the browser so the bar animates ---- */
  progress(0.02, 'shaping the basin');
  const gen = bakeTerrain(progress);
  const baked = await new Promise((resolve) => {
    // rAF alone would stall the whole load if the tab is backgrounded before
    // the bake finishes, so race it against a timer and take whichever fires.
    const schedule = (fn) => {
      let fired = false;
      const go = () => { if (!fired) { fired = true; fn(); } };
      requestAnimationFrame(go);
      setTimeout(go, 26);
    };
    const pump = () => {
      // Nobody is watching a hidden tab, and its timers are throttled to ~1 Hz,
      // so chunking there would stall the load indefinitely. Just finish.
      const budget = document.hidden ? 1e9 : 14;
      const t0 = performance.now();
      let res;
      do { res = gen.next(); } while (!res.done && performance.now() - t0 < budget);
      if (res.done) resolve(res.value); else schedule(pump);
    };
    schedule(pump);
  });

  progress(0.76, 'generating imagery');
  const tex = await loadTextures();
  // fill in whatever was not supplied on disk
  if (!tex.earthDay || !tex.earthNight || !tex.earthClouds) {
    Object.assign(tex, makeEarthTextures(), tex);   // existing entries win
  }
  if (!tex.moonAlbedo) tex.moonAlbedo = makeMoonAlbedo();
  progress(0.90, 'downlinking imagery');

  progress(0.94, 'assembling MU-7');
  const terrain = new Terrain(engine.renderer, baked, engine.quality, engine.caps);
  terrain.uniforms.uAlbedoTex.value = tex.moonAlbedo;
  engine.scene.add(terrain.group);

  const sky = new Sky(engine.renderer, engine.scene, tex, engine.quality);
  const props = new Props(engine.scene, terrain, engine.quality);
  props.buildHome();
  props.buildStation(STATION.x, STATION.z);
  // survey pylons the previous crew left behind
  [[-60, 180], [-150, 40], [60, -140], [190, 60], [-250, -110]].forEach((p, i) =>
    props.buildPylon(p[0], p[1], i));
  // the lattice breaking surface in a few places
  [[-118, -64, 1.3], [86, -152, 1.0], [-206, 96, 1.15], [24, 118, 0.9], [-40, -218, 1.25]]
    .forEach(([x, z, s]) => props.buildLatticeNode(x, z, s));
  props.buildLatticeNode(MASSIF.x + 6, MASSIF.z - 4, 2.1, true);

  const dust = new Dust(engine.scene, terrain, terrain.uniforms.uSunDir, engine.quality.dust);
  const rover = new Rover(terrain, engine.scene);
  rover.panelTarget = 0;
  const rig = new CameraRig(engine.camera, terrain);
  const audio = new Audio();
  const hud = new HUD(audio);
  hud.bakeMap(terrain);

  const input = new Input($('stage'));
  const game = new Game({
    terrain, rover, props, dust, sky, audio, hud, engine, rig, scene: engine.scene, input,
    telemetry: backend
  });
  game.tc = App.settings.tc;

  Object.assign(App, { terrain, sky, props, dust, rover, rig, audio, hud, input, game, tex });

  applySettings();
  buildSettingsUI();
  buildHelpUI();
  wireUI();

  App.tick = tick;
  App.startGame = startGame;
  window.REGOLITH = App;                 // debug handle: inspect or drive from the console
  progress(1, 'link established');
  await new Promise(r => setTimeout(r, 260));
  $('boot').classList.add('hidden');
  showMenu();
  requestAnimationFrame(frame);
}

/* ============================================================
   MENUS
   ============================================================ */
function showMenu() {
  App.state = ST.MENU;
  $('menu').classList.remove('hidden');
  App.hud.hideHUD();
  App.input.unlock();
  App.input.showTouch(false);
  const saved = Save.read();
  $('btnContinue').hidden = !saved;
  $('menuBrief').innerHTML =
    `Two hundred and fourteen days ago the far-side outpost <b>BEACON-9</b> sent four seconds of
     empty carrier and stopped. You are the operator of <b>MU-7 CASSIOPEIA</b>, put down by descent
     sled on the floor of <b>Anaxagoras</b> at seventy-three degrees north.<br><br>
     Survey the basin. Restore the relay chain. Find out what is under the floor —
     and why the dossier does not say what the station was <em>for</em>.`;
  backend.track('main_menu', 'viewed', { has_local_save: !!saved }, { dedupeMs: 5000 });
}

function startGame(freeRoam, loadSaved) {
  App.audio.init(); App.audio.resume();
  App.audio.setVolumes(App.settings.volSfx, App.settings.volMusic);
  App.audio.setMusic(App.settings.music);

  $('menu').classList.add('hidden');
  App.hud.show();
  App.game.reset(freeRoam);
  App.terrain.clearDent();
  App.terrain.clearTrails();
  App.dust.clear();
  App.props.levelPad();

  App.rover.placeAt(HOME.x - 8, HOME.z - 7, 2.3);
  App.rig.setMode(CAM.CHASE, App.rover);

  let resumed = false;
  if (loadSaved) resumed = App.game.load(Save.read());

  App.state = ST.PLAY;
  App.input.lock();
  App.input.showTouch(true);
  App.hud.log('MU-7 CASSIOPEIA — SYSTEMS NOMINAL', 'good');
  App.hud.log('SELENE DIRECTORATE · FAR-SIDE SURVEY DIVISION');
  const mode = freeRoam ? 'free_survey' : 'campaign';
  backend.startPlay(mode, resumed, {
    mission_index: App.game.missionIdx,
    input_method: inputMethod()
  });
  App.game.event(freeRoam ? 'free_survey' : `mission_${String(App.game.missionIdx + 1).padStart(2, '0')}`,
    resumed ? 'resumed' : 'started', { input_method: inputMethod() });

  if (!resumed && !freeRoam) {
    setTimeout(() => {
      App.hud.showCard(MISSIONS[0]); App.state = ST.CARD;
      App.input.unlock(); App.input.showTouch(false);
    }, 700);
  } else if (freeRoam) {
    App.hud.log('FREE SURVEY — no objectives, no oversight', 'good');
  }
}

/* Where a closing panel should hand control back to. openPanel overwrites
   App.state, so the `state !== ST.MENU` test the close paths used could never
   see MENU: opening CONTROLS or SYSTEMS from the main menu dropped you into
   ST.PLAY and grabbed the pointer, before the game had even started. */
let panelReturn = ST.MENU;

function openPanel(id, state) {
  if (App.state === ST.MENU || App.state === ST.PLAY) panelReturn = App.state;
  App.state = state;
  $(id).classList.remove('hidden');
  App.input.unlock();
  App.input.showTouch(false);
  App.audio.ui('tick');
  backend.track('menus', 'opened', { panel: id, from_state: panelReturn });
}
function closePanels() {
  for (const id of ['pause', 'codex', 'help']) $(id).classList.add('hidden');
  if (panelReturn === ST.MENU) showMenu();
  else { App.state = ST.PLAY; App.input.lock(); App.input.showTouch(true); }
  backend.track('menus', 'closed', { return_state: panelReturn });
}

function wireUI() {
  $('btnPlay').onclick = () => { Save.clear(); startGame(false, false); };
  $('btnContinue').onclick = () => startGame(false, true);
  $('btnFreeRoam').onclick = () => startGame(true, false);
  $('btnControls').onclick = () => openPanel('help', ST.HELP);
  $('btnSettings').onclick = () => openPanel('pause', ST.PAUSE);
  $('btnResume').onclick = closePanels;
  $('btnHelp').onclick = () => { $('pause').classList.add('hidden'); openPanel('help', ST.HELP); };
  $('btnCodexFromPause').onclick = () => { $('pause').classList.add('hidden'); openPanel('codex', ST.CODEX); };
  $('btnAbort').onclick = () => {
    Save.write(App.game.save());
    backend.endPlay('abort_to_menu', gameContext());
    for (const id of ['pause', 'codex', 'help']) $(id).classList.add('hidden');
    showMenu();
  };
  $('cardGo').onclick = () => {
    App.hud.hideCard();
    App.state = ST.PLAY; App.input.lock(); App.input.showTouch(true);
    App.audio.ui('ok');
    backend.track('mission_briefing', 'acknowledged', { mission_index: App.game.missionIdx });
  };
  // one close path, so the ESC button and the Escape key cannot diverge
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closePanels);
  $('accessRetry').onclick = () => location.reload();
  addEventListener('beforeunload', () => {
    if (App.game && App.state >= ST.PLAY) Save.write(App.game.save());
    backend.endPlay('page_unload', gameContext());
  });
}

/* ---------------- settings ---------------- */
function buildSettingsUI() {
  const body = $('settingsBody');
  const S = App.settings;
  const rows = [];
  const settingKey = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const seg = (label, note, opts, get, set) => rows.push(
    { type: 'seg', key: settingKey(label), label, note, opts, get, set });
  const rng = (label, note, min, max, step, get, set) => rows.push(
    { type: 'rng', key: settingKey(label), label, note, min, max, step, get, set });

  seg('RENDER QUALITY', 'clipmap, shadows, excavation grid, boulders, particles',
    ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'],
    () => ['low', 'medium', 'high', 'ultra'].indexOf(S.quality),
    // setQuality rebuilds the composer, so the final-pass uniforms are new
    // objects — re-apply the user's settings or grain/aberration silently reset.
    (i) => {
      S.quality = ['low', 'medium', 'high', 'ultra'][i];
      App.engine.setQuality(S.quality);
      applyWorldQuality();
      applySettings();
      persist();
    });
  seg('BLOOM', 'veiling glare around bright sources', ['OFF', 'ON'],
    () => S.bloom ? 1 : 0, (i) => { S.bloom = !!i; App.engine.bloom.enabled = !!i; persist(); });
  seg('SENSOR NOISE', 'grain that rises in shadow', ['OFF', 'LOW', 'FULL'],
    () => S.grain === 0 ? 0 : S.grain < 0.7 ? 1 : 2,
    (i) => { S.grain = [0, 0.5, 1][i]; applySettings(); persist(); });
  seg('CHROMATIC ABERRATION', 'lens fringing at the frame edge', ['OFF', 'ON'],
    () => S.aberr ? 1 : 0, (i) => { S.aberr = i ? 1 : 0; applySettings(); persist(); });
  seg('STARFIELD', 'cinematic keeps stars visible in sunlight', ['REALISTIC', 'CINEMATIC'],
    () => S.stars > 0.5 ? 1 : 0, (i) => { S.stars = i ? 1 : 0.22; applySettings(); persist(); });
  seg('DRIVE ENVELOPE', 'LRV: 13 km/h, a 45 s drill, and a pack that lasts half an hour',
    ['ARCADE', 'LRV'],
    () => S.realistic ? 1 : 0,
    (i) => { S.realistic = !!i; applySettings(); persist();
      App.hud.log(i ? 'PROFILE — LRV · 3.6 m/s · 45 s CORE · EXTENDED PACK' : 'PROFILE — ARCADE'); });
  seg('SIGNAL DELAY', 'drive commands cross to the Moon and back before the rover acts',
    ['OFF', 'EARTH 2.6 s'],
    () => S.comms ? 1 : 0,
    (i) => { S.comms = !!i; applySettings(); persist();
      App.hud.log(i ? 'UPLINK — 1.28 s EACH WAY, ROUND TRIP 2.56 s' : 'UPLINK — LOCAL CONTROL'); });
  seg('HUD SIZE', 'scales every instrument panel together', ['SMALL', 'NORMAL', 'LARGE'],
    () => S.hudScale < 0.92 ? 0 : S.hudScale > 1.08 ? 2 : 1,
    (i) => { S.hudScale = [0.82, 1, 1.18][i]; applySettings(); persist(); });
  seg('CAMERA AUTO-CENTRE', 'chase view drifts back behind the rover', ['OFF', 'SLOW', 'FAST'],
    () => S.autoCentre, (i) => { S.autoCentre = i; App.rig.autoCentre = i; persist(); });
  seg('INVERT LOOK', '', ['OFF', 'ON'],
    () => S.invertY ? 1 : 0, (i) => { S.invertY = !!i; applySettings(); persist(); });
  seg('TRACTION CONTROL', 'limits hub torque before the wheels dig in', ['OFF', 'ON'],
    () => S.tc ? 1 : 0, (i) => { S.tc = !!i; App.game.tc = !!i; persist(); });
  seg('SCORE', 'generative, D minor, patient', ['OFF', 'ON'],
    () => S.music ? 1 : 0, (i) => { S.music = !!i; App.audio.setMusic(!!i); persist(); });
  rng('FIELD OF VIEW', 'degrees', 42, 82, 1, () => S.fov, (v) => { S.fov = v; App.rig.fovScale = v / 58; persist(); });
  rng('LOOK SENSITIVITY', '', 0.25, 3, 0.05, () => S.sens, (v) => { S.sens = v; applySettings(); persist(); });
  rng('EFFECTS VOLUME', '', 0, 1, 0.05, () => S.volSfx, (v) => { S.volSfx = v; App.audio.setVolumes(v, S.volMusic); persist(); });
  rng('MUSIC VOLUME', '', 0, 1, 0.05, () => S.volMusic, (v) => { S.volMusic = v; App.audio.setVolumes(S.volSfx, v); persist(); });

  body.innerHTML = '';
  for (const r of rows) {
    const d = document.createElement('div'); d.className = 'set-row';
    const l = document.createElement('label');
    l.innerHTML = `${r.label}${r.note ? `<small>${r.note}</small>` : ''}`;
    d.appendChild(l);
    if (r.type === 'seg') {
      const s = document.createElement('div'); s.className = 'seg';
      r.opts.forEach((o, i) => {
        const b = document.createElement('button'); b.textContent = o;
        b.onclick = () => {
          r.set(i);
          [...s.children].forEach((c, j) => c.classList.toggle('on', j === i));
          backend.track('settings_menu', 'setting_changed', { setting_key: r.key, option_index: i });
          App.audio.ui('tick');
        };
        s.appendChild(b);
      });
      [...s.children].forEach((c, j) => c.classList.toggle('on', j === r.get()));
      d.appendChild(s);
    } else {
      const wrap = document.createElement('div');
      const i = document.createElement('input');
      i.type = 'range'; i.min = r.min; i.max = r.max; i.step = r.step; i.value = r.get();
      const v = document.createElement('span');
      v.style.cssText = 'margin-left:10px;font-size:10px;color:#6fe3f5;min-width:34px;display:inline-block';
      v.textContent = (+r.get()).toFixed(r.step < 1 ? 2 : 0);
      i.oninput = () => { r.set(+i.value); v.textContent = (+i.value).toFixed(r.step < 1 ? 2 : 0); };
      i.onchange = () => backend.track('settings_menu', 'setting_changed', {
        setting_key: r.key, value: +i.value
      }, { dedupeKey: `setting:${r.key}:${i.value}`, dedupeMs: 500 });
      wrap.appendChild(i); wrap.appendChild(v);
      d.appendChild(wrap);
    }
    body.appendChild(d);
  }
}
function persist() { Save.saveSettings(App.settings); }

function inputMethod() {
  if (App.input?.touch?.active) return 'touch';
  if (App.input?.pad !== null && App.input?.pad !== undefined) return 'gamepad';
  return 'keyboard_mouse';
}

function gameContext() {
  if (!App.game) return {};
  return {
    mission_index: App.game.missionIdx,
    mission_complete: !App.game.mission,
    play_duration_seconds: Math.round(App.game.met || 0),
    distance_meters: Math.round(App.rover?.odo || 0),
    input_method: inputMethod()
  };
}

/* Save the frame that was just drawn. Photo mode hides the HUD already, so what
   lands on disk is what you framed. */
function saveFrame() {
  try {
    const url = App.engine.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    const t = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `regolith-${t}.png`;
    a.href = url;
    a.click();
    App.hud.log('FRAME SAVED', 'good');
    App.audio.ui('ok');
  } catch (e) {
    App.hud.log('FRAME CAPTURE FAILED', 'bad');
  }
}

/* Push a tier change through to everything that sized itself from it at boot.
   Engine.setQuality only re-fits the framebuffer, the shadow map and the
   composer; the clipmap, the excavation grid, the trail buffer, the sun mask,
   the boulder density and the dust budget all live out here and used to be
   frozen at whatever guessQuality picked on the first run. On a tablet that
   meant RENDER QUALITY moved almost nothing.

   Cheap because bakeTerrain takes no quality argument: the height field is
   tier-independent, so none of this re-bakes the basin. */
function applyWorldQuality() {
  const q = App.engine.quality;
  App.terrain?.setQuality(q);
  App.props?.setQuality(q);
  App.sky?.setQuality(q);
  App.dust?.setMax(q.dust);
}

function applySettings() {
  const S = App.settings, e = App.engine;
  e.final.uniforms.uGrain.value = S.grain;
  e.final.uniforms.uAberr.value = S.aberr;
  e.bloom.enabled = S.bloom;
  App.rig.invertY = S.invertY;
  App.rig.sens = S.sens;
  App.rig.autoCentre = S.autoCentre;
  App.rig.fovScale = S.fov / 58;
  App.sky.starIntensity = S.stars;
  // Apollo's LRV cruised at ~13 km/h; the arcade default is 30. Every speed
  // threshold in the rover, camera and audio is a fraction of this, so the one
  // assignment retunes all of them.
  DRIVE.maxSpeed = S.realistic ? 3.6 : 8.4;
  DRIVE.commsDelay = S.comms ? EARTH_RTT : 0;
  OPS.drillTime = S.realistic ? 45 : 4.2;
  OPS.drainScale = S.realistic ? 0.125 : 1;
  // one knob for every instrument dimension; the stylesheet does the rest
  document.documentElement.style.setProperty('--hud-k', S.hudScale);
  if (App.audio.ready) App.audio.setVolumes(S.volSfx, S.volMusic);
}

function buildHelpUI() {
  $('keysBody').innerHTML = `
    <div class="keygroup"><h4>DRIVE</h4>
      ${row('Throttle / reverse', 'W', 'S')}${row('Steer', 'A', 'D')}
      ${row('Brake', 'SPACE')}${row('Right the chassis', 'X')}
    </div>
    <div class="keygroup"><h4>SCIENCE</h4>
      ${row('Ground-penetrating radar', 'G')}${row('Deploy / stow sampling arm', 'R')}
      ${row('Aim arm: reach', 'W', 'S')}${row('Aim arm: swing', 'A', 'D')}
      ${row('Drill at the aim point', 'LMB')}
      ${row('Deploy relay beacon', 'B')}${row('Deploy / stow solar array', 'T')}
      ${row('Interact (hold)', 'E')}
    </div>
    <div class="keygroup"><h4>SYSTEMS</h4>
      ${row('Headlights', 'F')}${row('Camera mode', 'C')}
      ${row('Photo mode', 'P')}${row('Codex', 'TAB')}
      ${row('Pause / systems', 'ESC')}${row('Toggle HUD', 'H')}
    </div>
    <div class="keygroup"><h4>VIEW</h4>
      ${row('Look', 'MOUSE')}${row('Zoom', 'WHEEL')}
      ${row('In photo mode: fly', 'W', 'A', 'S', 'D')}
      ${row('In photo mode: up / down', 'Q', 'Z')}${row('In photo mode: boost', 'SHIFT')}
      ${row('Save the frame as a PNG', 'K')}
    </div>
    <div class="keygroup"><h4>NOTES FROM THE OPERATIONS MANUAL</h4>
      <div class="keyrow"><span>One sixth of a gravity is one sixth of the grip. Brake early.</span></div>
      <div class="keyrow"><span>The radar reaches 78 m. Sweep, then drive to the return.</span></div>
      <div class="keyrow"><span>Park, deploy the arm, put the reticle on the marker, then drill.</span></div>
      <div class="keyrow"><span>Shadowed ground does not charge the array. Watch the terminator.</span></div>
      <div class="keyrow"><span>The sled recharges you and takes your samples. It is 400 m of nothing away.</span></div>
    </div>`;
  function row(label, ...keys) {
    return `<div class="keyrow"><span>${label}</span><b>${keys.map(k => `<kbd>${k}</kbd>`).join(' ')}</b></div>`;
  }
}

/* ============================================================
   FRAME
   ============================================================ */
let last = performance.now(), acc = 0, fpsT = 0, fpsN = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;
  tick(dt);
}

/** One simulated + rendered frame. Exposed on the debug handle so a headless
    driver can advance the game without relying on rAF. */
function tick(dt) {
  const playing = App.state === ST.PLAY;

  const input = App.input;
  const raw = input.poll();

  /* ---------------- global keys ---------------- */
  if (input.hit('Escape')) {
    if (App.state === ST.PLAY) openPanel('pause', ST.PAUSE);
    else if (App.state === ST.PAUSE || App.state === ST.CODEX || App.state === ST.HELP) closePanels();
  }
  if (input.hit('Tab')) {
    if (App.state === ST.PLAY) { App.hud.refreshCodex(App.game); openPanel('codex', ST.CODEX); }
    else if (App.state === ST.CODEX) closePanels();
  }
  if (input.hit('KeyH') && App.state >= ST.PLAY) {
    App.settings.hudOn = !App.settings.hudOn;
    App.hud.el.hud.style.opacity = App.settings.hudOn ? '' : '0';
  }

  if (playing) stepWorld(dt, raw, input);
  else if (App.state !== ST.BOOT) idleWorld(dt);

  /* ---------------- sun bearing on screen, for the flare ---------------- */
  const sp = _v.copy(App.sky.sunDir).multiplyScalar(4000).add(App.engine.camera.position)
    .project(App.engine.camera);
  const front = App.sky.sunDir.dot(App.engine.camera.getWorldDirection(_v2)) > 0;
  const vis = front && App.sky.sunDir.y > -0.02
    ? clamp(1 - Math.max(Math.abs(sp.x), Math.abs(sp.y)) * 0.42, 0, 1) * clamp(App.sky.sunDir.y * 14, 0, 1)
    : 0;
  App.engine.final.uniforms.uSunUV.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5, vis * 0.9);

  App.engine.render(dt);
  // Must run in the same task as the draw: the drawing buffer is cleared before
  // the next event loop turn unless preserveDrawingBuffer is on, which costs
  // performance on every frame to serve a key almost nobody presses.
  if (App.wantShot) { App.wantShot = false; saveFrame(); }
  input.endFrame();

  fpsT += dt; fpsN++;
  if (fpsT > 1) {
    App.fps = fpsN / fpsT; fpsT = 0; fpsN = 0;
    if (playing && (!App._perfEventT || App.elapsed - App._perfEventT >= 60)) {
      App._perfEventT = App.elapsed;
      backend.track('performance', 'sampled', {
        fps: Math.round(App.fps),
        quality: App.settings.quality,
        viewport_width: innerWidth,
        viewport_height: innerHeight,
        mission_index: App.game.missionIdx,
        input_method: inputMethod()
      }, { dedupeKey: `performance:${Math.floor(App.elapsed / 60)}`, dedupeMs: 30_000 });
    }
  }
  void acc;
}

/* ---------------- the world when nobody is driving ---------------- */
function idleWorld(dt) {
  App.elapsed += dt;
  App.sunAz += dt * 0.0060;
  App.sky.setSun(App.sunAz, sunAltitude(App.sunAz));
  syncSun();
  // a slow orbit over the basin behind the menus
  const t = App.elapsed * 0.045;
  const cx = Math.cos(t) * 150, cz = Math.sin(t) * 150;
  const cy = App.terrain.heightAt(cx, cz) + 46 + Math.sin(t * 1.7) * 10;
  App.engine.camera.position.set(cx, cy, cz);
  App.engine.camera.lookAt(0, App.terrain.heightAt(0, 0) + 14, 0);
  App.terrain.update(dt, App.engine.camera, App.sky.sunDir);
  App.sky.update(dt, App.engine.camera, App.elapsed);
  App.props.update(dt, App.elapsed, App.engine.camera);
  App.engine.aimShadow(_v.set(cx, cy - 40, cz), App.sky.sunDir);
}

/* Commands in flight to the rover.

   Only the DRIVE axes go through here, not arm aiming and not the camera. That
   is a design call, not a modelling shortcut, and it is worth being explicit
   about: latency is interesting where it forces anticipation — you brake before
   you think you need to, and a boulder you can already see is one you may
   already have hit. Aiming a drill is point-and-hold; the same 2.6 s there is
   friction with no decision in it. The chase camera is not a real camera on a
   real rover at all, so delaying it would buy nothing. */
const cmdQueue = [];

function pumpCommands(now, live) {
  const d = DRIVE.commsDelay;
  if (d <= 0) { cmdQueue.length = 0; return live; }
  cmdQueue.push({ t: now, ...live });
  // Everything stamped before now-d has arrived; the last of those is what the
  // rover is acting on. Nothing yet => the first commands are still crossing.
  let arrived = null;
  while (cmdQueue.length && cmdQueue[0].t <= now - d) arrived = cmdQueue.shift();
  return arrived || { throttle: 0, steer: 0, brake: 0 };
}

/* ---------------- driving ---------------- */
function stepWorld(dt, raw, input) {
  const { rover, terrain, sky, props, dust, game, rig, engine, audio, hud } = App;
  App.elapsed += dt;

  /* ---- sun: at 73° N it circles rather than arcs ---- */
  App.sunAz += dt * 0.0060;
  sky.setSun(App.sunAz, sunAltitude(App.sunAz));
  syncSun();
  if (!App._envT || App.elapsed - App._envT > 6) { App._envT = App.elapsed; sky.markEnvDirty(); }

  /* ---- controls ---- */
  const photo = rig.mode === CAM.PHOTO;
  const sent = pumpCommands(App.elapsed, {
    throttle: photo ? 0 : raw.throttle,
    steer: photo ? 0 : raw.steer,
    brake: photo ? 1 : raw.brake,
  });
  const ctl = { throttle: sent.throttle, steer: sent.steer, brake: sent.brake, tc: game.tc };
  if (photo) { ctl.throttle = 0; ctl.steer = 0; ctl.brake = 1; }
  App.cmdInFlight = cmdQueue.length;

  if (input.hit('KeyF')) { rover.headlights = !rover.headlights; audio.ui('tick'); hud.log(rover.headlights ? 'LAMPS ON' : 'LAMPS OFF'); }
  if (input.hit('KeyG')) game.doScan();

  /* ---- arm: R deploys it, then the drive keys aim it ----
     Reusing WASD costs no new bindings and is unambiguous, because you have to
     be stopped to drill anyway. The hill hold keeps the chassis where you left
     it while you line the bit up. */
  if (input.hit('KeyR')) game.toggleArm();
  if (rover.armOut) {
    const spd = dt * 1.5;
    rover.armYaw = clamp(rover.armYaw - raw.steer * spd, -0.95, 0.95);
    rover.armReach = clamp(rover.armReach + raw.throttle * spd * 0.8, 0.55, 1.62);
    ctl.throttle = 0; ctl.steer = 0; ctl.brake = 1;      // chassis is parked while aiming
    // `clicked` as well as `down`: a phone tap can begin and end between two
    // frames, and checking only `down` silently drops it.
    if ((input.mouse.down || input.mouse.clicked) && !game.drill.active) game.startDrill();
  }
  if (input.hit('KeyB')) game.deployRelay();
  if (input.hit('KeyT')) game.togglePanel();
  if (input.hit('KeyC')) { rig.cycle(rover); if (rig.mode === CAM.PHOTO) rig.enterPhoto(rover); audio.ui('tick'); }
  if (input.hit('KeyK')) App.wantShot = true;
  if (input.hit('KeyP')) {
    rig.setMode(rig.mode === CAM.PHOTO ? CAM.CHASE : CAM.PHOTO, rover);
    if (rig.mode === CAM.PHOTO) rig.enterPhoto(rover);
    audio.ui('tick');
  }
  engine.final.uniforms.uLetterbox.value +=
    ((rig.mode === CAM.PHOTO ? 0.22 : 0) - engine.final.uniforms.uLetterbox.value) * Math.min(1, dt * 6);

  rover.lampPower += ((rover.headlights ? 1 : 0) - rover.lampPower) * Math.min(1, dt * 5);

  /* ---- physics ---- */
  if (!photo) {
    rover.hardHit = 0;
    rover.step(dt, ctl, terrain);
    const impact = props.resolve(rover);
    if (impact > 1.6) { game.damage(impact * 1.8, 'BOULDER'); rig.addShake(clamp(impact * 0.16, 0, 1)); }
    if (rover.hardHit > 3.2) {
      game.damage((rover.hardHit - 3.2) * 2.4, 'HARD LANDING');
      rig.addShake(clamp(rover.hardHit * 0.11, 0, 1));
      audio.thud(clamp(rover.hardHit * 0.25, 0.3, 2));
      const p = rover.pos;
      dust.spawn(Math.min(70, 12 + rover.hardHit * 8), p.x, terrain.heightAt(p.x, p.z), p.z,
        clamp(rover.hardHit * 0.30, 0.5, 2.4), 1.3);
    }
    rover.sync();
  }
  rover.updateVisuals(dt, ctl);

  /* ---- tracks + dust from the wheels ---- */
  let slipSum = 0, spinMax = 0, roughSum = 0, contacts = 0;
  for (const w of rover.wheels) {
    spinMax = Math.max(spinMax, Math.abs(w.spinVel));
    if (!w.contact) { w.lastGround.copy(w.worldPos); continue; }
    contacts++;
    slipSum += w.slipLong + w.slipLat;
    roughSum += Math.min(Math.abs(w.compVel) * 0.30, 1);
    // A suspension stop taking a hit is a discrete event, not part of a bed —
    // give it its own transient, panned to the side the wheel is on.
    if (w.compVel > 1.9 && (w._clunk || 0) <= 0) {
      audio.clunk((w.compVel - 1.9) * 0.30, w.side * 0.45);
      w._clunk = 0.22;
    }
    w._clunk = Math.max(0, (w._clunk || 0) - dt);
    const gx = w.worldPos.x, gz = w.worldPos.z;
    const dx = gx - w.lastGround.x, dz = gz - w.lastGround.z;
    const moved = Math.hypot(dx, dz);
    if (moved > 0.10) {
      // One pass must already read as a track; repeats deepen it toward black.
      const strength = clamp(0.52 + w.load / 900 * 0.26 + w.slipLong * 0.30, 0, 0.95);
      terrain.addTrack(w.lastGround.x, w.lastGround.z, gx, gz, 0.44, strength);
      // The rut is real geometry, not a decal: sinkage sets the depth, and the
      // regolith the wheel pushes down comes back up as berms on both flanks.
      const depth = Math.min(0.115, 0.045 + w.sink * 2.0 + w.slipLong * 0.06);
      const steps = Math.min(6, Math.ceil(moved / 0.12));
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        terrain.rut(w.lastGround.x + dx * f, w.lastGround.z + dz * f, 0.26, depth, 0);
      }
      w.lastGround.set(gx, w.worldPos.y, gz);
    }
    // Wheelspin excavates. Keep the throttle down in soft ground and you will
    // dig a hole and drop into it, exactly as you would on the real thing.
    if (w.slipLong > 0.22 && Math.abs(rover.speed) < 2.4) {
      terrain.rut(gx, gz, 0.27, 0.06, (w.slipLong - 0.18) * dt * 0.42);
    }
    /* Rooster tails. The grousers fling regolith whether or not the wheel is
       slipping, and at 1/6 g it arcs for twenty metres before it lands — the
       single most recognisable thing about driving on the Moon. */
    const surf = Math.abs(w.spinVel) * 0.335;
    const slip = w.slipLong;
    if (surf > 0.8 && contacts > 0) {
      const rate = (surf * 3.4 + slip * 55) * dt;
      let n = Math.floor(rate);
      if (Math.random() < rate - n) n++;
      if (n > 0) {
        const f = rover.forward;
        const sgn = Math.sign(w.spinVel) || 1;
        dust.spawn(Math.min(n, 4), gx, w.worldPos.y - 0.26, gz,
          0.30 + surf * 0.16 + slip * 1.7, 0.20, -f.x * sgn, -f.z * sgn);
      }
    }
  }
  const speed = rover.vel.length();

  /* ---- lighting the rover: is it in a crater shadow? ---- */
  if (!App._sunVisT || App.elapsed - App._sunVisT > 0.18) {
    App._sunVisT = App.elapsed;
    App._sunVisTarget = terrain.sunVis(rover.pos.x, rover.pos.z, sky.sunDir);
    props.padLight = 1 - terrain.sunVis(HOME.x, HOME.z, sky.sunDir);
  }
  rover.sunVis = lerp(rover.sunVis, App._sunVisTarget ?? 1, Math.min(1, dt * 3));
  engine.sun.intensity = 3.0 * lerp(0.06, 1, rover.sunVis) * clamp(sky.sunDir.y * 12, 0, 1);

  /* ---- hand three's directional shadow map to the terrain shader ----
     The terrain is a custom material, so it is invisible to the built-in
     shadow plumbing; without this the rover and every boulder float. */
  const sh = engine.sun.shadow;
  if (engine.sun.castShadow && sh.map) {
    terrain.uniforms.uRShadow.value = sh.map.texture;
    terrain.uniforms.uRShadowMat.value.copy(sh.matrix);
    terrain.uniforms.uRShadowTexel.value = 1 / sh.mapSize.x;
    terrain.uniforms.uRShadowOn.value = 1;
  } else terrain.uniforms.uRShadowOn.value = 0;

  /* ---- headlight cone into the terrain shader ---- */
  const lampPos = _v.copy(rover.pos).addScaledVector(rover.forward, 1.1).addScaledVector(rover.up, 0.62);
  terrain.uniforms.uLamp.value.copy(lampPos);
  terrain.uniforms.uLampDir.value.copy(rover.forward).addScaledVector(rover.up, -0.30).normalize();
  terrain.uniforms.uLampPow.value = rover.lampPower;

  /* ---- world systems ---- */
  dust.update(dt);
  terrain.update(dt, engine.camera, sky.sunDir);
  sky.update(dt, engine.camera, App.elapsed);
  props.update(dt, App.elapsed, engine.camera);
  game.update(dt, ctl, input);
  rig.update(dt, rover, {
    lookX: raw.lookX, lookY: raw.lookY, zoom: raw.zoom, looking: raw.looking,
    boost: input.down('ShiftLeft', 'ShiftRight'),
    up: input.down('KeyQ'), down: input.down('KeyZ')
  }, photo ? { throttle: raw.throttle, steer: raw.steer } : { throttle: 0, steer: 0 });
  engine.aimShadow(rover.pos, sky.sunDir);

  /* ---- audio mix ---- */
  audio.update(dt, {
    wheelSpin: spinMax, motorLoad: rover.motorLoad, speed,
    slip: clamp(slipSum / 6, 0, 1), rough: clamp(roughSum / 6, 0, 1),
    drilling: game.drill.active, contacts, alarm: game.dangerTone,
    maxSpeed: DRIVE.maxSpeed, spinRef: rover.spinRef
  });
  audio.musicTick(App.elapsed, game.dangerTone);

  /* ---- post ---- */
  engine.final.uniforms.uGlitch.value = Math.max(0,
    engine.final.uniforms.uGlitch.value - dt * 2.2);
  if (game.hull < 40) engine.final.uniforms.uGlitch.value =
    Math.max(engine.final.uniforms.uGlitch.value, (1 - game.hull / 40) * 0.10 * Math.random());
  engine.final.uniforms.uExposure.value = lerp(engine.final.uniforms.uExposure.value,
    1.0 + (1 - rover.sunVis) * 0.55, Math.min(1, dt * 0.9));

  hud.update(dt, game, rover, sky, rig);

  /* ---- autosave ---- */
  if (!App._saveT || App.elapsed - App._saveT > 20) { App._saveT = App.elapsed; Save.write(game.save()); }
}

/** At 73° N the sun never gets high and never sets — it circles the horizon,
    bobbing between about 17° and 31°. Long shadows all day, sweeping like a
    sundial, and a rim wall that keeps its own floor in the dark for hours. */
function sunAltitude(az) {
  return 0.42 + Math.sin(az * 0.5 - 0.4) * 0.12;      // 17° … 31°
}

function syncSun() {
  const { sky, terrain, engine } = App;
  terrain.uniforms.uSunDir.value.copy(sky.sunDir);
  terrain.uniforms.uEarthDir.value.copy(sky.earthDir);
  const lo = clamp(sstep(-0.02, 0.10, sky.sunDir.y), 0, 1);
  terrain.uniforms.uSunCol.value.set(2.62 * lo, 2.46 * lo, 2.22 * lo);
  engine.sun.position.copy(sky.sunDir).multiplyScalar(100);
  engine.fill.intensity = 0.22 + 0.16 * lo;
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

/* ============================================================ */
addEventListener('error', (e) => {
  const t = $('loadtext');
  if (t && !$('boot').classList.contains('hidden')) {
    t.textContent = 'LINK FAILURE — ' + (e.message || 'unknown');
    t.style.color = '#ff5f56';
  }
  backend.track('errors', 'runtime_error', {
    phase: App.state === ST.BOOT ? 'boot' : 'runtime',
    error_type: e.error?.name || 'javascript_error'
  }, { dedupeKey: `error:${e.error?.name || 'javascript_error'}`, dedupeMs: 5000 });
  console.error(e.error || e.message);
});

boot().catch((err) => {
  console.error(err);
  if (err instanceof BackendAccessError) {
    $('accessDeniedMessage').textContent = err.playerMessage;
    $('accessRetry').onclick = () => location.reload();
    $('accessDenied').classList.remove('hidden');
    return;
  }
  backend.track('errors', 'boot_failed', { error_type: err?.name || 'boot_error' },
    { dedupeKey: 'boot-failed', dedupeMs: 60_000 });
  const t = $('loadtext');
  if (t) { t.textContent = 'THE GAME COULD NOT START. RELOAD TO TRY AGAIN.'; t.style.color = '#ff5f56'; }
});

void PLAYABLE_R; void QUALITY; void Props;
