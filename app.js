(function () {
  'use strict';

  var state = {
    status: null,
    analysis: null,
    changes: null,
    snapshots: [],
    activeTab: 'notBack',
    query: '',
    against: null,
    syncing: false,
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    connChip: $('connChip'),
    btnConnect: $('btnConnect'), btnSync: $('btnSync'), btnDisconnect: $('btnDisconnect'),
    connectPanel: $('connectPanel'), btnConnectBig: $('btnConnectBig'), configWarning: $('configWarning'),
    dropFollowers: $('dropFollowers'), fileFollowers: $('fileFollowers'), followersFileName: $('followersFileName'),
    dropFollowing: $('dropFollowing'), fileFollowing: $('fileFollowing'), followingFileName: $('followingFileName'),
    dropMulti: $('dropMulti'), fileMulti: $('fileMulti'),
    status: $('status'), lastSync: $('lastSync'), changesBanner: $('changesBanner'),
    results: $('results'),
    statFollowers: $('statFollowers'), statFollowing: $('statFollowing'), statMutual: $('statMutual'),
    statNotBack: $('statNotBack'), statFans: $('statFans'),
    tabs: $('tabs'), search: $('search'), btnCsv: $('btnCsv'),
    changesPanel: $('changesPanel'), changesGrid: $('changesGrid'), changesEmpty: $('changesEmpty'),
    snapshotSelect: $('snapshotSelect'),
    userList: $('userList'), emptyList: $('emptyList'),
    snapshotList: $('snapshotList'), noSnapshots: $('noSnapshots'),
    btnSample: $('btnSample'), btnClear: $('btnClear'), toast: $('toast'),
  };

  var TAB_LISTS = {
    notBack: function (a) { return a.notFollowingBack; },
    fans: function (a) { return a.fans; },
    mutual: function (a) { return a.mutual; },
    followers: function (a) { return a.followers; },
    following: function (a) { return a.following; },
  };

  // ---------- API ----------

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error((body && body.error) || ('HTTP ' + res.status));
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  function postJson(path, obj) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
  }

  // ---------- UI helpers ----------

  function showStatus(msg, isError) {
    els.status.hidden = false;
    els.status.textContent = msg;
    els.status.style.background = isError ? '#3a1d22' : 'rgba(47,191,113,0.08)';
    els.status.style.borderColor = isError ? 'var(--bad)' : 'rgba(47,191,113,0.4)';
    els.status.style.color = isError ? '#ffb4b8' : 'var(--text)';
  }

  function hideStatus() { els.status.hidden = true; }

  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2600);
  }

  function avatarColor(username) {
    var h = 0;
    for (var i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 360;
    return 'hsl(' + h + ', 65%, 45%)';
  }

  function renderUserList(container, usernames, query) {
    container.innerHTML = '';
    var q = (query || '').trim().toLowerCase();
    var shown = usernames.filter(function (u) { return !q || u.toLowerCase().indexOf(q) !== -1; });
    shown.forEach(function (u) {
      var li = document.createElement('li');
      var av = document.createElement('span');
      av.className = 'avatar';
      av.style.background = avatarColor(u);
      av.textContent = u.charAt(0).toUpperCase();
      var name = document.createElement('span');
      name.className = 'username';
      var a = document.createElement('a');
      a.href = 'https://www.instagram.com/' + encodeURIComponent(u) + '/';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = u;
      name.appendChild(a);
      var copy = document.createElement('button');
      copy.className = 'copy-btn';
      copy.type = 'button';
      copy.textContent = 'copy';
      copy.addEventListener('click', function () { copyUsername(u, copy); });
      li.appendChild(av);
      li.appendChild(name);
      li.appendChild(copy);
      container.appendChild(li);
    });
    return shown.length;
  }

  function copyUsername(u, btn) {
    function done() {
      toast('Copied @' + u);
      if (btn) { btn.textContent = '✓'; setTimeout(function () { btn.textContent = 'copy'; }, 1200); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(u).then(done, function () { fallbackCopy(u); done(); });
    } else {
      fallbackCopy(u);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  // ---------- connection / status ----------

  function renderConnection() {
    var s = state.status || {};
    if (s.authenticated) {
      els.connChip.textContent = '● connected as @' + (s.username || '?');
      els.connChip.className = 'conn-chip ok';
      els.btnConnect.hidden = true;
      els.btnConnectBig.hidden = true;
      els.btnSync.hidden = false;
      els.btnDisconnect.hidden = false;
      els.connectPanel.hidden = true;
    } else {
      els.connChip.textContent = '● not connected';
      els.connChip.className = 'conn-chip off';
      els.btnConnect.hidden = !s.configured;
      els.btnSync.hidden = true;
      els.btnDisconnect.hidden = true;
      els.connectPanel.hidden = false;
      els.configWarning.hidden = Boolean(s.configured);
      els.btnConnectBig.hidden = !s.configured;
    }
    if (s.lastSnapshotTs) {
      els.lastSync.hidden = false;
      els.lastSync.textContent = 'Last sync: ' + new Date(s.lastSnapshotTs).toLocaleString() +
        (s.tokenExpiresAt ? ' · access token expires ' + new Date(s.tokenExpiresAt).toLocaleDateString() : '');
    } else {
      els.lastSync.hidden = true;
    }
  }

  // ---------- data ----------

  function applyData(body) {
    state.analysis = body.analysis || null;
    state.changes = body.changes || null;
    state.snapshots = body.snapshots || [];
    if (state.snapshots.length > 1) {
      state.against = state.snapshots[state.snapshots.length - 2].ts;
    } else {
      state.against = null;
    }
    els.results.hidden = !state.analysis;
    renderAll();
  }

  function refreshData() {
    return api('/api/analysis').then(applyData).catch(function (e) { showStatus(e.message, true); });
  }

  function syncNow() {
    if (state.syncing) return;
    state.syncing = true;
    els.btnSync.disabled = true;
    els.btnSync.textContent = '⟳ Syncing…';
    hideStatus();
    api('/api/sync', { method: 'POST' }).then(function (body) {
      applyData(body);
      toast('Synced @' + ((body.snapshot && body.snapshot.username) || '') + ' — ' +
        body.snapshot.followers + ' followers, ' + body.snapshot.following + ' following');
      refreshStatus();
    }).catch(function (e) {
      showStatus(e.message, true);
    }).finally(function () {
      state.syncing = false;
      els.btnSync.disabled = false;
      els.btnSync.textContent = '⟳ Sync now';
    });
  }

  function refreshStatus() {
    return api('/api/status').then(function (s) { state.status = s; renderConnection(); });
  }

  function loadChangesFor(ts) {
    state.against = ts;
    var url = '/api/changes' + (ts ? '?against=' + encodeURIComponent(ts) : '');
    return api(url).then(function (body) {
      state.changes = body.changes || null;
      renderTab();
      updateChangesBanner();
    });
  }

  // ---------- rendering ----------

  function renderAll() {
    var a = state.analysis;
    if (!a) return;
    els.statFollowers.textContent = a.followers.length;
    els.statFollowing.textContent = a.following.length;
    els.statMutual.textContent = a.mutual.length;
    els.statNotBack.textContent = a.notFollowingBack.length;
    els.statFans.textContent = a.fans.length;
    $('countNotBack').textContent = a.notFollowingBack.length;
    $('countFans').textContent = a.fans.length;
    $('countMutual').textContent = a.mutual.length;
    $('countFollowers').textContent = a.followers.length;
    $('countFollowing').textContent = a.following.length;
    var ch = state.changes;
    var chTotal = ch ? ch.newFollowers.length + ch.lostFollowers.length + ch.newFollowing.length + ch.lostFollowing.length : 0;
    $('countChanges').textContent = state.snapshots.length > 1 ? chTotal : '';
    renderSnapshotOptions();
    renderSnapshots();
    renderTab();
    updateChangesBanner();
  }

  function updateChangesBanner() {
    if (!state.analysis || !state.changes) { els.changesBanner.hidden = true; return; }
    var ch = state.changes;
    els.changesBanner.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = 'Changes vs snapshot ' + (state.against ? new Date(state.against).toLocaleString() : '(previous)') + ': ';
    els.changesBanner.appendChild(strong);
    els.changesBanner.appendChild(document.createTextNode(
      '+' + ch.newFollowers.length + ' new followers, −' + ch.lostFollowers.length + ' unfollowed you, ' +
      '+' + ch.newFollowing.length + ' newly followed, −' + ch.lostFollowing.length + ' unfollowed. ' +
      'See the “Changes / unfollowers” tab.'
    ));
    els.changesBanner.hidden = false;
  }

  function renderTab() {
    var isChanges = state.activeTab === 'changes';
    var hasChanges = Boolean(state.changes);
    els.changesPanel.hidden = !isChanges;
    els.userList.hidden = isChanges;
    if (isChanges) {
      els.changesEmpty.hidden = hasChanges;
      els.changesGrid.style.display = hasChanges ? '' : 'none';
      if (hasChanges) renderChanges();
    } else {
      els.emptyList.hidden = true;
      if (!state.analysis) return;
      var list = TAB_LISTS[state.activeTab](state.analysis);
      var shown = renderUserList(els.userList, list, state.query);
      els.emptyList.hidden = shown !== 0;
    }
    Array.prototype.forEach.call(els.tabs.querySelectorAll('.tab'), function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
    });
  }

  function renderChanges() {
    var ch = state.changes;
    if (!ch) return;
    setChangeGroup('NewFollowers', 'listNewFollowers', ch.newFollowers);
    setChangeGroup('LostFollowers', 'listLostFollowers', ch.lostFollowers);
    setChangeGroup('NewFollowing', 'listNewFollowing', ch.newFollowing);
    setChangeGroup('LostFollowing', 'listLostFollowing', ch.lostFollowing);
  }

  function setChangeGroup(countId, listId, usernames) {
    $('ch' + countId).textContent = usernames.length;
    renderUserList($(listId), usernames, state.query);
  }

  function renderSnapshotOptions() {
    els.snapshotSelect.innerHTML = '';
    state.snapshots.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.ts;
      opt.textContent = new Date(s.ts).toLocaleString() + ' · ' + s.source + ' · ' + s.followers + 'F/' + s.following + 'FG';
      els.snapshotSelect.appendChild(opt);
    });
    if (state.snapshots.length && state.against) {
      els.snapshotSelect.value = String(state.against);
    }
  }

  function renderSnapshots() {
    els.snapshotList.innerHTML = '';
    els.noSnapshots.hidden = state.snapshots.length > 0;
    state.snapshots.forEach(function (s) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      label.textContent = new Date(s.ts).toLocaleString();
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = s.source + (s.username ? ' · @' + s.username : '') + ' · ' + s.followers + ' followers · ' + s.following + ' following';
      var spacer = document.createElement('span');
      spacer.className = 'spacer';
      var del = document.createElement('button');
      del.className = 'btn ghost danger';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', function () {
        api('/api/snapshots/' + s.ts, { method: 'DELETE' }).then(function () {
          toast('Snapshot deleted');
          refreshData();
        }).catch(function (e) { showStatus(e.message, true); });
      });
      li.appendChild(label);
      li.appendChild(meta);
      li.appendChild(spacer);
      li.appendChild(del);
      els.snapshotList.appendChild(li);
    });
  }

  function exportCsv() {
    if (!state.analysis) return;
    var rows;
    var name;
    if (state.activeTab === 'changes') {
      var ch = state.changes;
      if (!ch) { toast('Sync at least twice to see changes'); return; }
      rows = ch.lostFollowers.concat(ch.newFollowers);
      name = 'changes';
    } else {
      rows = TAB_LISTS[state.activeTab](state.analysis).filter(function (u) {
        var q = state.query.trim().toLowerCase();
        return !q || u.toLowerCase().indexOf(q) !== -1;
      });
      name = state.activeTab;
    }
    var blob = new Blob([FollowAudit.toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'follow-audit-' + name + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Exported ' + rows.length + ' usernames to CSV');
  }

  // ---------- upload (manual fallback) ----------

  function readJsonFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try { resolve(JSON.parse(reader.result)); } catch (e) { reject(new Error('"' + file.name + '" is not valid JSON.')); }
      };
      reader.onerror = function () { reject(new Error('Could not read "' + file.name + '".')); };
      reader.readAsText(file);
    });
  }

  var pendingUpload = { followersRaw: null, followingRaw: null };

  function assignFile(kind, file) {
    return readJsonFile(file).then(function (data) {
      pendingUpload[kind === 'followers' ? 'followersRaw' : 'followingRaw'] = data;
      if (kind === 'followers') {
        els.followersFileName.textContent = file.name + ' ✓';
        els.dropFollowers.classList.add('filled');
      } else {
        els.followingFileName.textContent = file.name + ' ✓';
        els.dropFollowing.classList.add('filled');
      }
      maybeUpload();
    });
  }

  function maybeUpload() {
    if (!pendingUpload.followersRaw || !pendingUpload.followingRaw) return;
    hideStatus();
    postJson('/api/upload', pendingUpload).then(function (body) {
      pendingUpload = { followersRaw: null, followingRaw: null };
      applyData(body);
      toast('Export uploaded and saved as a snapshot');
    }).catch(function (e) {
      showStatus(e.message, true);
    });
  }

  function handleMultiFiles(files) {
    var errors = [];
    Array.prototype.forEach.call(files, function (file) {
      var kind = FollowAudit.detectKind(file.name);
      if (!kind) {
        errors.push('"' + file.name + '" — name must contain "followers" or "following".');
        return;
      }
      assignFile(kind, file).catch(function (e) { errors.push(e.message); });
    });
    if (errors.length) showStatus(errors.join(' '), true);
  }

  function wireDropzone(zone, input, onFiles) {
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      onFiles(input.files);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
    });
  }

  // ---------- wire up ----------

  wireDropzone(els.dropFollowers, els.fileFollowers, function (files) { if (files[0]) assignFile('followers', files[0]).catch(function (e) { showStatus(e.message, true); }); });
  wireDropzone(els.dropFollowing, els.fileFollowing, function (files) { if (files[0]) assignFile('following', files[0]).catch(function (e) { showStatus(e.message, true); }); });
  wireDropzone(els.dropMulti, els.fileMulti, handleMultiFiles);

  els.tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (!btn) return;
    state.activeTab = btn.dataset.tab;
    renderTab();
  });

  els.search.addEventListener('input', function () {
    state.query = els.search.value;
    renderTab();
  });

  els.btnCsv.addEventListener('click', exportCsv);
  els.btnSync.addEventListener('click', syncNow);

  els.btnDisconnect.addEventListener('click', function () {
    api('/auth/logout', { method: 'POST' }).then(function () {
      toast('Disconnected from Instagram');
      refreshStatus();
    }).catch(function (e) { showStatus(e.message, true); });
  });

  els.btnSample.addEventListener('click', function () {
    var sample = FollowAuditSample.generate(42);
    postJson('/api/analyze', { followersRaw: sample.followersRaw, followingRaw: sample.followingRaw }).then(function (body) {
      state.analysis = body.analysis;
      els.results.hidden = false;
      renderAll();
      toast('Sample data loaded (not saved as a snapshot)');
    }).catch(function (e) { showStatus(e.message, true); });
  });

  els.btnClear.addEventListener('click', function () {
    api('/api/snapshots', { method: 'DELETE' }).then(function () {
      toast('All snapshots cleared');
      refreshData();
      refreshStatus();
    }).catch(function (e) { showStatus(e.message, true); });
  });

  els.snapshotSelect.addEventListener('change', function () {
    loadChangesFor(els.snapshotSelect.value ? Number(els.snapshotSelect.value) : null);
  });

  // ---------- boot ----------

  var params = new URLSearchParams(location.search);
  if (params.get('connected') === '1') toast('Instagram connected — press “⟳ Sync now”');

  refreshStatus().then(refreshData);
})();
