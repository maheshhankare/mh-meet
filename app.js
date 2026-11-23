import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://iwhmvvckpsfbpkdpmfrn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jPZVVYaWhK_iKOk8jVrsJQ_fm99MnsK'; // public key, safe in browser
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

const $ = (id) => document.getElementById(id);
const myId = crypto.randomUUID().slice(0, 8);
let myName = localStorage.getItem('mh_name') || '';
let roomId = null;
let localStream = null;
let screenTrack = null;
let channel = null;
const peers = new Map(); // id -> { pc, name, tile, pendingIce: [] }

// ---------- Intro ----------
const intro = $('intro'), introVideo = $('introVideo');
const hideIntro = () => { introVideo.pause(); intro.classList.add('hidden'); };
$('skipBtn').onclick = hideIntro;
introVideo.onended = hideIntro;
introVideo.onerror = hideIntro;
setTimeout(() => { if (introVideo.readyState === 0) hideIntro(); }, 4000);

// ---------- Routing ----------
function show(screen) {
  for (const s of ['home', 'lobby', 'call']) $(s).classList.toggle('hidden', s !== screen);
}
function newCode() {
  const a = 'abcdefghijkmnopqrstuvwxyz';
  const part = (n) => Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join('');
  return `${part(3)}-${part(4)}-${part(3)}`;
}
function parseCode(v) {
  v = v.trim();
  try { const u = new URL(v); return u.searchParams.get('room') || u.pathname.replace(/\//g, ''); } catch { return v.replace(/[^a-z0-9-]/gi, '').toLowerCase(); }
}
function goRoom(code) {
  history.pushState({}, '', `/?room=${code}`);
  openLobby(code);
}

$('nameInput').value = myName;
$('newBtn').onclick = () => { saveName($('nameInput').value); goRoom(newCode()); };
$('joinBtn').onclick = () => { const c = parseCode($('codeInput').value); if (c) { saveName($('nameInput').value); goRoom(c); } };
$('codeInput').onkeydown = (e) => { if (e.key === 'Enter') $('joinBtn').click(); };

function saveName(n) { myName = (n || '').trim() || myName; if (myName) localStorage.setItem('mh_name', myName); }

async function openLobby(code) {
  roomId = code;
  show('lobby');
  $('lobbyRoom').textContent = `Meeting code: ${code}`;
  $('lobbyName').value = myName;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { localStream = new MediaStream(); $('lobbyErr').textContent = 'No camera/mic access — you can still join and watch.'; }
  }
  $('previewVideo').srcObject = localStream;
}

$('enterBtn').onclick = () => {
  saveName($('lobbyName').value);
  if (!myName) myName = 'Guest ' + myId.slice(0, 3);
  joinCall();
};

// ---------- Tiles ----------
function makeTile(id, name, isMe) {
  const t = document.createElement('div');
  t.className = 'tile' + (isMe ? ' me' : '');
  t.innerHTML = `<video autoplay playsinline ${isMe ? 'muted' : ''}></video><div class="avatar">${(name || '?')[0].toUpperCase()}</div><div class="name"></div>`;
  t.querySelector('.name').textContent = isMe ? `${name} (You)` : name;
  t.id = 'tile-' + id;
  $('grid').appendChild(t);
  return t;
}
function setTileName(tile, name) {
  tile.querySelector('.name').textContent = name;
  tile.querySelector('.avatar').textContent = (name || '?')[0].toUpperCase();
}

// ---------- Call ----------
let myTile;
async function joinCall() {
  show('call');
  $('roomLabel').textContent = roomId;
  myTile = makeTile(myId, myName, true);
  myTile.querySelector('video').srcObject = localStream;
  updateButtons();

  channel = supabase.channel(`mh-meet:${roomId}`, { config: { presence: { key: myId }, broadcast: { self: false } } });

  channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
    if (payload.to === myId) handleSignal(payload);
  });
  channel.on('broadcast', { event: 'chat' }, ({ payload }) => addChat(payload.name, payload.text));
  channel.on('broadcast', { event: 'state' }, ({ payload }) => {
    const p = peers.get(payload.from);
    if (p) { p.tile.classList.toggle('camoff', !payload.cam); if (payload.name) { p.name = payload.name; setTileName(p.tile, payload.name); } }
  });

  channel.on('presence', { event: 'sync' }, () => {
    const state = channel.presenceState();
    const present = new Set(Object.keys(state));
    for (const id of present) {
      if (id === myId || peers.has(id)) continue;
      const name = state[id][0]?.name || 'Guest';
      // Deterministic initiator: lower id makes the offer.
      if (myId < id) connectTo(id, name, true);
    }
    for (const id of [...peers.keys()]) if (!present.has(id)) removePeer(id);
  });

  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') await channel.track({ name: myName, at: Date.now() });
  });
}

function send(event, payload) { channel?.send({ type: 'broadcast', event, payload }); }

function connectTo(id, name, initiator) {
  const pc = new RTCPeerConnection(ICE);
  const tile = makeTile(id, name, false);
  const remote = new MediaStream();
  tile.querySelector('video').srcObject = remote;
  const peer = { pc, name, tile, pendingIce: [] };
  peers.set(id, peer);

  // Always add transceivers so we can enable cam/mic/screen later without renegotiating.
  const a = localStream.getAudioTracks()[0];
  const v = screenTrack || localStream.getVideoTracks()[0];
  if (a) pc.addTrack(a, localStream); else pc.addTransceiver('audio', { direction: 'sendrecv' });
  if (v) pc.addTrack(v, localStream); else pc.addTransceiver('video', { direction: 'sendrecv' });

  pc.ontrack = (e) => { if (!remote.getTracks().includes(e.track)) remote.addTrack(e.track); };
  pc.onicecandidate = (e) => { if (e.candidate) send('signal', { from: myId, to: id, kind: 'ice', data: e.candidate.toJSON(), name: myName }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { sendState(); toast(`${peer.name} joined`); }
    if (pc.connectionState === 'failed') { toast(`Connection to ${peer.name} failed (network/NAT)`); pc.restartIce?.(); }
  };

  if (initiator) {
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send('signal', { from: myId, to: id, kind: 'offer', data: pc.localDescription.toJSON(), name: myName });
    })();
  }
  return peer;
}

async function handleSignal({ from, kind, data, name }) {
  let peer = peers.get(from);
  if (!peer) {
    if (kind !== 'offer') return;
    peer = connectTo(from, name || 'Guest', false);
  }
  const { pc } = peer;
  if (kind === 'offer') {
    await pc.setRemoteDescription(data);
    await flushIce(peer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send('signal', { from: myId, to: from, kind: 'answer', data: pc.localDescription.toJSON(), name: myName });
  } else if (kind === 'answer') {
    await pc.setRemoteDescription(data);
    await flushIce(peer);
  } else if (kind === 'ice') {
    if (pc.remoteDescription) await pc.addIceCandidate(data).catch(() => {});
    else peer.pendingIce.push(data);
  }
}
async function flushIce(peer) { for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {}); }

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close(); p.tile.remove(); peers.delete(id);
  toast(`${p.name} left`);
}

// ---------- Controls ----------
const camTrack = () => localStream.getVideoTracks()[0];
const micTrack = () => localStream.getAudioTracks()[0];
function sendState() { send('state', { from: myId, cam: !!(screenTrack || camTrack()?.enabled), name: myName }); }
function updateButtons() {
  $('micBtn').classList.toggle('off', !micTrack()?.enabled);
  $('camBtn').classList.toggle('off', !camTrack()?.enabled);
  $('shareBtn').classList.toggle('on', !!screenTrack);
  myTile.classList.toggle('camoff', !screenTrack && !camTrack()?.enabled);
  myTile.classList.toggle('screen', !!screenTrack);
}
$('micBtn').onclick = () => { const t = micTrack(); if (t) t.enabled = !t.enabled; updateButtons(); };
$('camBtn').onclick = () => { const t = camTrack(); if (t) t.enabled = !t.enabled; updateButtons(); sendState(); };

function replaceVideo(track) {
  for (const { pc } of peers.values()) {
    const s = pc.getSenders().find((s) => s.track?.kind === 'video') || pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
    s?.replaceTrack(track);
  }
  myTile.querySelector('video').srcObject = new MediaStream([track, ...localStream.getAudioTracks()].filter(Boolean));
}
$('shareBtn').onclick = async () => {
  if (screenTrack) return stopShare();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenTrack = s.getVideoTracks()[0];
    screenTrack.onended = stopShare;
    replaceVideo(screenTrack);
    updateButtons(); sendState();
  } catch {}
};
function stopShare() {
  screenTrack?.stop(); screenTrack = null;
  replaceVideo(camTrack() || null);
  myTile.querySelector('video').srcObject = localStream;
  updateButtons(); sendState();
}

$('leaveBtn').onclick = async () => {
  for (const id of [...peers.keys()]) { peers.get(id).pc.close(); }
  await channel?.untrack(); await supabase.removeChannel(channel);
  localStream.getTracks().forEach((t) => t.stop());
  location.href = '/';
};
$('copyBtn').onclick = async () => { await navigator.clipboard.writeText(location.href); toast('Invite link copied'); };

// ---------- Chat ----------
$('chatBtn').onclick = () => $('chatPanel').classList.toggle('hidden');
$('chatClose').onclick = () => $('chatPanel').classList.add('hidden');
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  send('chat', { name: myName, text });
  addChat('You', text);
  $('chatInput').value = '';
};
function addChat(name, text) {
  const d = document.createElement('div');
  d.className = 'msg';
  d.innerHTML = '<div class="who"></div><div class="txt"></div>';
  d.querySelector('.who').textContent = name;
  d.querySelector('.txt').textContent = text;
  $('chatLog').appendChild(d);
  $('chatLog').scrollTop = 1e9;
  if ($('chatPanel').classList.contains('hidden')) toast(`💬 ${name}: ${text}`);
}

let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3000); }

// ---------- Boot ----------
const initial = new URLSearchParams(location.search).get('room');
if (initial) openLobby(parseCode(initial)); else show('home');
window.onpopstate = () => location.reload();
