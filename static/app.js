(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const storageKey = "via.route.draft.v1";

  const state = {
    nodes: [],
    routeStyle: "polyline",
    closedLoop: false,
    speedKmh: 5,
    playing: false,
    progress: 0,
    animationFrame: 0,
    lastFrame: 0,
    lastDevicePush: 0,
    connected: false,
    selectedDevice: "",
  };

  const map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    zoomAnimation: true,
    fadeAnimation: false,
    markerZoomAnimation: true,
  }).setView([23.1291, 113.2644], 13);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 2,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const routeLayer = L.polyline([], {
    color: "#435f4b",
    weight: 5,
    opacity: 0.9,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(map);

  const runnerIcon = L.divIcon({
    className: "",
    html: '<div class="via-runner"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  const nodeIcon = L.divIcon({
    className: "",
    html: '<div class="via-node"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

  const runner = L.marker([0, 0], { icon: runnerIcon, interactive: false, zIndexOffset: 1000 });
  const nodeMarkers = [];

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  function haversine(a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const p1 = a.lat * rad;
    const p2 = b.lat * rad;
    const dP = (b.lat - a.lat) * rad;
    const dL = (b.lng - a.lng) * rad;
    const h = Math.sin(dP / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dL / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function catmullRom(points, closed, samplesPerSegment = 12) {
    if (points.length < 3) return points.map((p) => ({ ...p }));
    const pts = points.map((p) => ({ lat: p.lat, lng: p.lng }));
    const out = [];
    const n = pts.length;

    const get = (i) => {
      if (closed) return pts[(i + n) % n];
      return pts[Math.max(0, Math.min(n - 1, i))];
    };

    const segmentCount = closed ? n : n - 1;
    for (let i = 0; i < segmentCount; i++) {
      const p0 = get(i - 1);
      const p1 = get(i);
      const p2 = get(i + 1);
      const p3 = get(i + 2);
      for (let s = 0; s < samplesPerSegment; s++) {
        const t = s / samplesPerSegment;
        const t2 = t * t;
        const t3 = t2 * t;
        out.push({
          lat: 0.5 * ((2 * p1.lat) + (-p0.lat + p2.lat) * t +
            (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * t2 +
            (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * t3),
          lng: 0.5 * ((2 * p1.lng) + (-p0.lng + p2.lng) * t +
            (2 * p0.lng - 5 * p1.lng + 4 * p2.lng - p3.lng) * t2 +
            (-p0.lng + 3 * p1.lng - 3 * p2.lng + p3.lng) * t3),
        });
      }
    }
    out.push(closed ? { ...pts[0] } : { ...pts[n - 1] });
    return out;
  }

  function routePoints() {
    if (state.nodes.length === 0) return [];
    let points = state.nodes.map((p) => ({ lat: p.lat, lng: p.lng }));
    if (state.routeStyle === "smooth") points = catmullRom(points, state.closedLoop);
    else if (state.closedLoop && points.length > 1) points = [...points, { ...points[0] }];
    return points;
  }

  function routeDistance(points = routePoints()) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i]);
    return total;
  }

  function pointAtProgress(progress) {
    const points = routePoints();
    if (!points.length) return null;
    if (points.length === 1) return points[0];
    const total = routeDistance(points);
    if (total <= 0) return points[0];

    let target = Math.max(0, Math.min(1, progress)) * total;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const len = haversine(a, b);
      if (target <= len || i === points.length - 1) {
        const f = len > 0 ? target / len : 0;
        return {
          lat: a.lat + (b.lat - a.lat) * f,
          lng: a.lng + (b.lng - a.lng) * f,
        };
      }
      target -= len;
    }
    return points[points.length - 1];
  }

  function saveDraft() {
    localStorage.setItem(storageKey, JSON.stringify({
      format: "route-studio-v1",
      name: "VIA route",
      routeStyle: state.routeStyle,
      closedLoop: state.closedLoop,
      speedKmh: state.speedKmh,
      nodes: state.nodes.map((n) => ({ lat: n.lat, lng: n.lng })),
    }));
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.nodes)) return;
      state.nodes = data.nodes
        .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      state.routeStyle = data.routeStyle === "smooth" ? "smooth" : "polyline";
      state.closedLoop = Boolean(data.closedLoop);
      state.speedKmh = Number.isFinite(Number(data.speedKmh)) ? Number(data.speedKmh) : 5;
    } catch {
      // ignore malformed local draft
    }
  }

  function rebuildMarkers() {
    nodeMarkers.splice(0).forEach((marker) => marker.remove());
    state.nodes.forEach((node, index) => {
      const marker = L.marker([node.lat, node.lng], {
        draggable: true,
        icon: nodeIcon,
        zIndexOffset: 200 + index,
      }).addTo(map);
      marker.on("drag", (event) => {
        const ll = event.target.getLatLng();
        state.nodes[index] = { lat: ll.lat, lng: ll.lng };
        updateRoute(false);
      });
      marker.on("dragend", () => {
        saveDraft();
        renderNodeList();
      });
      nodeMarkers.push(marker);
    });
  }

  function renderNodeList() {
    const list = $("#nodeList");
    $("#nodeCount").textContent = `${state.nodes.length} 个`;
    $("#summaryNodes").textContent = `${state.nodes.length} nodes`;
    if (!state.nodes.length) {
      list.innerHTML = '<div class="empty-state">点击右侧地图开始布设路线</div>';
      return;
    }
    list.innerHTML = state.nodes.map((node, index) => `
      <div class="node-row" data-index="${index}">
        <div class="node-index">${index + 1}</div>
        <div class="node-copy">
          <strong>节点 ${index + 1}</strong>
          <span>${node.lat.toFixed(6)}, ${node.lng.toFixed(6)}</span>
        </div>
        <button class="icon-btn delete-node" title="删除" data-index="${index}">删除</button>
      </div>`).join("");

    $$(".delete-node").forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = Number(btn.dataset.index);
        state.nodes.splice(index, 1);
        state.progress = 0;
        saveDraft();
        rebuildMarkers();
        updateRoute();
      });
    });

    $$(".node-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest(".delete-node")) return;
        const index = Number(row.dataset.index);
        const node = state.nodes[index];
        map.panTo([node.lat, node.lng], { animate: true });
      });
    });
  }

  function updateMetrics() {
    const meters = routeDistance();
    const km = meters / 1000;
    $("#distanceValue").textContent = `${km.toFixed(2)} km`;
    $("#summaryDistance").textContent = `${km.toFixed(2)} km`;
    const hours = state.speedKmh > 0 ? km / state.speedKmh : 0;
    const minutes = Math.round(hours * 60);
    $("#etaValue").textContent = meters > 0 ? `${minutes} min` : "--";
    $("#progressValue").textContent = `${Math.round(state.progress * 100)}%`;
    $("#progressFill").style.width = `${Math.max(0, Math.min(100, state.progress * 100))}%`;
  }

  function updateRoute(save = true) {
    routeLayer.setLatLngs(routePoints());
    renderNodeList();
    updateMetrics();
    const point = pointAtProgress(state.progress);
    if (point) {
      runner.setLatLng([point.lat, point.lng]);
      if (!map.hasLayer(runner)) runner.addTo(map);
    } else if (map.hasLayer(runner)) {
      runner.remove();
    }
    if (save) saveDraft();
  }

  function addNode(latlng) {
    state.nodes.push({ lat: latlng.lat, lng: latlng.lng });
    state.progress = 0;
    rebuildMarkers();
    updateRoute();
  }

  async function jsonFetch(url, options) {
    const response = await fetch(url, options);
    let data = null;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function refreshDevices() {
    try {
      const data = await jsonFetch("/api/android/devices");
      $("#adbMissing").classList.toggle("hidden", data.status?.adb !== false);
      const select = $("#deviceSelect");
      const current = select.value;
      select.innerHTML = '<option value="">选择已授权 Android 设备</option>';
      (data.devices || []).forEach((device) => {
        const option = document.createElement("option");
        option.value = device.serial;
        option.textContent = [device.model || device.serial, device.state].filter(Boolean).join(" · ");
        if (device.state !== "device") option.disabled = true;
        select.appendChild(option);
      });
      if ([...select.options].some((o) => o.value === current)) select.value = current;
      renderDeviceStatus(data.status);
    } catch (error) {
      $("#adbMissing").classList.remove("hidden");
      renderDeviceStatus({ adb: false, connected: false });
    }
  }

  function renderDeviceStatus(status = {}) {
    state.connected = Boolean(status.connected);
    $("#deviceState").textContent = state.connected ? "已连接" : (status.adb === false ? "未检测到 adb" : "未连接");
    $("#deviceSerial").textContent = status.serial || "--";
    if (status.lastLocation) {
      $("#deviceLocation").textContent = `${Number(status.lastLocation.lat).toFixed(6)}, ${Number(status.lastLocation.lng).toFixed(6)}`;
    } else {
      $("#deviceLocation").textContent = "--";
    }
    $("#connectBtn").disabled = state.connected;
    $("#disconnectBtn").disabled = !state.connected;
    $("#clearMockBtn").disabled = !state.connected;
    $("#bridgeStatus").textContent = state.connected ? "Android 已连接" : "本地桥接服务";
  }

  async function connectDevice() {
    const serial = $("#deviceSelect").value;
    if (!serial) return toast("先选择设备");
    try {
      const status = await jsonFetch("/api/android/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial }),
      });
      renderDeviceStatus(status);
      toast("Android 已连接");
      const p = pointAtProgress(state.progress);
      if (p) await pushLocation(p);
    } catch (error) {
      toast(error.message);
    }
  }

  async function pushLocation(point) {
    if (!state.connected || !point) return;
    try {
      const status = await jsonFetch("/api/android/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: point.lat, lng: point.lng, accuracy: 5 }),
      });
      renderDeviceStatus(status);
    } catch (error) {
      toast(error.message);
      state.playing = false;
      updatePlayButton();
    }
  }

  async function disconnectDevice() {
    try {
      const status = await jsonFetch("/api/android/disconnect", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      renderDeviceStatus(status);
      toast("已断开并尝试恢复真实定位");
    } catch (error) {
      toast(error.message);
    }
  }

  async function clearMock() {
    try {
      const status = await jsonFetch("/api/android/clear", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      renderDeviceStatus(status);
      toast("已清除测试定位源");
    } catch (error) {
      toast(error.message);
    }
  }

  function updatePlayButton() {
    $("#playBtn").textContent = state.playing ? "暂停" : (state.progress >= 1 ? "重新开始" : "开始");
  }

  function stopPlaybackAtEnd() {
    state.playing = false;
    state.progress = 1;
    updatePlayButton();
    updateMetrics();
  }

  function animationStep(now) {
    if (!state.playing) return;
    const dt = state.lastFrame ? Math.min(0.2, (now - state.lastFrame) / 1000) : 0;
    state.lastFrame = now;

    const meters = routeDistance();
    if (meters <= 0) {
      state.playing = false;
      updatePlayButton();
      return;
    }

    const speedMps = state.speedKmh / 3.6;
    state.progress += (speedMps * dt) / meters;

    if (state.progress >= 1) {
      if (state.closedLoop) state.progress %= 1;
      else state.progress = 1;
    }

    const point = pointAtProgress(state.progress);
    if (point) {
      runner.setLatLng([point.lat, point.lng]);
      if (!map.hasLayer(runner)) runner.addTo(map);
      if (state.connected && now - state.lastDevicePush >= 1000) {
        state.lastDevicePush = now;
        pushLocation(point);
      }
    }
    updateMetrics();

    if (!state.closedLoop && state.progress >= 1) {
      stopPlaybackAtEnd();
      return;
    }
    state.animationFrame = requestAnimationFrame(animationStep);
  }

  function togglePlayback() {
    if (state.nodes.length < 2) return toast("至少添加两个节点");
    if (state.playing) {
      state.playing = false;
      cancelAnimationFrame(state.animationFrame);
      updatePlayButton();
      return;
    }
    if (state.progress >= 1) state.progress = 0;
    state.playing = true;
    state.lastFrame = 0;
    state.lastDevicePush = 0;
    updatePlayButton();
    state.animationFrame = requestAnimationFrame(animationStep);
  }

  function resetPlayback() {
    state.playing = false;
    cancelAnimationFrame(state.animationFrame);
    state.progress = 0;
    state.lastFrame = 0;
    updatePlayButton();
    updateRoute(false);
    const point = pointAtProgress(0);
    if (state.connected && point) pushLocation(point);
  }

  function exportRoute() {
    const payload = {
      format: "route-studio-v1",
      name: "VIA route",
      routeStyle: state.routeStyle,
      closedLoop: state.closedLoop,
      speedKmh: state.speedKmh,
      nodes: state.nodes.map((n) => ({ lat: n.lat, lng: n.lng })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "via-route.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  }

  function importRoute(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.nodes)) throw new Error("缺少 nodes");
        const nodes = data.nodes.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
        if (nodes.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) throw new Error("节点坐标无效");
        state.nodes = nodes;
        state.routeStyle = data.routeStyle === "smooth" ? "smooth" : "polyline";
        state.closedLoop = Boolean(data.closedLoop);
        state.speedKmh = Number.isFinite(Number(data.speedKmh)) ? Number(data.speedKmh) : 5;
        state.progress = 0;
        syncControls();
        rebuildMarkers();
        updateRoute();
        if (nodes.length) map.fitBounds(L.latLngBounds(nodes.map((n) => [n.lat, n.lng])).pad(0.2));
        toast("路线已导入");
      } catch (error) {
        toast(`导入失败：${error.message}`);
      }
    };
    reader.readAsText(file, "utf-8");
  }

  async function searchPlaces() {
    const q = $("#searchInput").value.trim();
    if (!q) return;
    const results = $("#searchResults");
    results.innerHTML = '<div class="empty-state">搜索中...</div>';
    try {
      const data = await jsonFetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!Array.isArray(data) || !data.length) {
        results.innerHTML = '<div class="empty-state">没有找到地点</div>';
        return;
      }
      results.innerHTML = data.slice(0, 5).map((item, index) => `
        <button class="search-result" data-index="${index}">
          ${escapeHtml(item.name || item.display_name || "地点")}
          <small>${escapeHtml(item.display_name || "")}</small>
        </button>`).join("");
      $$(".search-result").forEach((button) => {
        button.addEventListener("click", () => {
          const item = data[Number(button.dataset.index)];
          const lat = Number(item.lat);
          const lng = Number(item.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
          map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate: true });
          results.innerHTML = "";
        });
      });
    } catch (error) {
      results.innerHTML = '<div class="empty-state">搜索暂时不可用</div>';
    }
  }

  function syncControls() {
    $$("[data-style]").forEach((btn) => btn.classList.toggle("active", btn.dataset.style === state.routeStyle));
    $("#closedLoop").checked = state.closedLoop;
    $("#speedInput").value = state.speedKmh;
    $("#speedLabel").textContent = `${state.speedKmh.toFixed(1)} km/h`;
    updatePlayButton();
  }

  map.on("click", (event) => {
    if (!$('[data-panel="edit"]').classList.contains("hidden")) addNode(event.latlng);
  });

  $$(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".mode-tab").forEach((x) => x.classList.toggle("active", x === tab));
      $$(".view-panel").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== tab.dataset.view));
      $(".map-hint").textContent = tab.dataset.view === "edit" ? "点击地图添加节点" : "路线回放";
      setTimeout(() => map.invalidateSize(), 60);
    });
  });

  $$("[data-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.routeStyle = btn.dataset.style;
      state.progress = 0;
      syncControls();
      updateRoute();
    });
  });

  $("#closedLoop").addEventListener("change", (event) => {
    state.closedLoop = event.target.checked;
    state.progress = 0;
    updateRoute();
  });

  $("#speedInput").addEventListener("input", (event) => {
    state.speedKmh = Number(event.target.value);
    $("#speedLabel").textContent = `${state.speedKmh.toFixed(1)} km/h`;
    saveDraft();
    updateMetrics();
  });

  $("#clearRouteBtn").addEventListener("click", () => {
    state.playing = false;
    state.nodes = [];
    state.progress = 0;
    cancelAnimationFrame(state.animationFrame);
    rebuildMarkers();
    updateRoute();
    updatePlayButton();
  });
  $("#exportBtn").addEventListener("click", exportRoute);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importRoute(file);
    event.target.value = "";
  });
  $("#searchBtn").addEventListener("click", searchPlaces);
  $("#searchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchPlaces();
  });
  $("#playBtn").addEventListener("click", togglePlayback);
  $("#resetBtn").addEventListener("click", resetPlayback);
  $("#refreshDevicesBtn").addEventListener("click", refreshDevices);
  $("#connectBtn").addEventListener("click", connectDevice);
  $("#disconnectBtn").addEventListener("click", disconnectDevice);
  $("#clearMockBtn").addEventListener("click", clearMock);

  loadDraft();
  syncControls();
  rebuildMarkers();
  updateRoute(false);
  refreshDevices();
})();