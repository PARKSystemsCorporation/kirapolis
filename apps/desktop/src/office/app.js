(function () {
  const params = new URLSearchParams(window.location.search);
  const embedMode = params.get("embed") === "1";
  const backgroundMode = params.get("background") === "1";
  const TILE_SIZE = 16;
  const DISPLAY_SCALE = backgroundMode ? 4 : (embedMode ? 4 : 4);
  const TILE_TYPES = {
    WALL: 0,
    VOID: 255,
  };

  const state = {
    agents: [],
    tasks: [],
    activity: [],
    chats: [],
    files: [],
    notes: [],
    selectedAgentId: null,
    selectedChatId: null,
    groupDraftMembers: [],
    menuAgentId: null,
    drawerView: "agent",
    formula: "",
    summary: {},
    officeLayout: null,
    furnitureCatalog: null,
    layoutBounds: null,
    workspace: {
      files: [],
      notes: [],
      selectedFile: "",
      selectedNote: "",
      fileContent: "",
      noteContent: "",
      filesDir: "",
      notesDir: "",
      filesMode: "list",
      notesMode: "list",
    },
    motion: {
      agents: {},
      rafId: 0,
      lastTick: 0,
      scene: null,
    },
    signals: {
      syncPulseToken: "",
      hotRooms: [],
      blockedAgentIds: [],
      promotedAgentIds: [],
      summary: {},
      momentum: null,
      spotlight: null,
      questBoard: [],
      promotionEvents: [],
      milestoneBosses: [],
      behaviorStates: [],
      behaviorSummary: {},
      socialLinks: [],
      pulseEvents: [],
      ambientState: null,
      directorMode: null,
    },
    roomTranscriptScroll: {
      chatId: null,
      scrollTop: 0,
      stickToBottom: true,
    },
  };

  const $ = (id) => document.getElementById(id);
  if (embedMode) {
    document.body.classList.add("embed-mode");
  }
  if (backgroundMode) {
    document.body.classList.add("background-mode");
  }

  const roleAnchors = {
    executive: [
      { col: 3, row: 12 },
      { col: 7, row: 12 },
      { col: 4, row: 18 },
    ],
    coder: [
      { col: 3, row: 16 },
      { col: 5, row: 16 },
      { col: 7, row: 16 },
      { col: 3, row: 18 },
      { col: 7, row: 18 },
    ],
    runner: [
      { col: 13, row: 13 },
      { col: 15, row: 13 },
      { col: 13, row: 16 },
      { col: 16, row: 18 },
      { col: 18, row: 18 },
    ],
  };

  const overlayLabels = [
    { label: "Command Wing", col: 2, row: 10, width: 7 },
    { label: "Build Pod", col: 2, row: 19, width: 6 },
    { label: "Comms Lounge", col: 12, row: 10, width: 7 },
  ];

  const utilityHotspots = [
    { id: "ops", label: "Ops Desk", detail: "Loop", col: 10, row: 11, view: "ops" },
    { id: "preview", label: "Workspace Gate", detail: "Site", col: 10, row: 21, view: "preview" },
    { id: "files", label: "File Shelf", detail: "Code", col: 2, row: 22, view: "files" },
    { id: "notes", label: "Notes Wall", detail: "Docs", col: 19, row: 21, view: "notes" },
  ];

  const socialAnchors = [
    { col: 13, row: 12 },
    { col: 15, row: 12 },
    { col: 14, row: 14 },
    { col: 12, row: 15 },
    { col: 16, row: 15 },
  ];

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function starMarkup(count) {
    return Array.from({ length: Math.max(1, Number(count) || 1) }, () => "&starf;").join("");
  }

  function agentById(agentId) {
    return state.agents.find((agent) => agent.id === agentId) || null;
  }

  function chatById(chatId) {
    return state.chats.find((chat) => chat.id === chatId) || null;
  }

  function behaviorStateForAgent(agentId) {
    return state.signals.behaviorStates.find((entry) => entry.agentId === agentId) || null;
  }

  function setBanner(message) {
    const target = $("office-banner");
    if (target) {
      target.textContent = message || "Ready.";
    }
  }

  function getPreviewUrl() {
    const url = new URL("/experience/project/", window.location.origin);
    if (embedMode) {
      url.searchParams.set("embed", "1");
      url.searchParams.set("source", "office-preview");
    }
    return url.toString();
  }

  async function requestJson(path, method = "GET", body) {
    const response = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Request failed: ${response.status}`);
    }
    return data;
  }

  function hashSeed(value) {
    let hash = 2166136261;
    for (const char of String(value || "")) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0);
  }

  function levelProgress(agent) {
    const progression = agent.progression || {};
    const xpInto = Number(progression.xpIntoLevel || 0);
    const xpForNext = Math.max(1, Number(progression.xpForNextLevel || 1));
    return Math.max(0, Math.min(100, Math.round((xpInto / xpForNext) * 100)));
  }

  function isAgentActive(agent) {
    const status = String(agent?.presence || agent?.state || "").toLowerCase();
    return ["active", "typing", "working", "executing", "waiting"].includes(status);
  }

  function isAgentWaiting(agent) {
    const status = String(agent?.presence || agent?.state || "").toLowerCase();
    return ["waiting", "blocked", "idle"].includes(status);
  }

  function tasksForAgent(agentId) {
    return state.tasks.filter((task) => task.agentId === agentId);
  }

  function computeChatSignal(chat) {
    const signalRoom = state.signals.hotRooms.find((entry) => entry.id === chat?.id);
    if (signalRoom) {
      return {
        tone: signalRoom.tone,
        label: signalRoom.tone === "hot" ? "Pulse" : signalRoom.tone === "warm" ? "Warm" : "Quiet",
        count: signalRoom.messageCount || 0,
      };
    }
    const count = Array.isArray(chat?.messages) ? chat.messages.length : 0;
    const lastMessage = count ? chat.messages[count - 1] : null;
    const ageMs = lastMessage?.createdAt ? Math.max(0, Date.now() - Number(lastMessage.createdAt)) : Number.POSITIVE_INFINITY;
    if (count >= 12 || ageMs < 10 * 60 * 1000) {
      return { tone: "hot", label: "Live", count };
    }
    if (count >= 5 || ageMs < 45 * 60 * 1000) {
      return { tone: "warm", label: "Warm", count };
    }
    return { tone: "cool", label: "Quiet", count };
  }

  function getZoneMetrics() {
    const signalSummary = state.signals.summary || {};
    const byRole = {
      executive: state.agents.filter((agent) => agent.role === "executive"),
      coder: state.agents.filter((agent) => agent.role === "coder"),
      runner: state.agents.filter((agent) => agent.role !== "executive" && agent.role !== "coder"),
    };

    const commandLoad = byRole.executive.filter(isAgentActive).length;
    const buildLoad = byRole.coder.reduce((total, agent) => total + tasksForAgent(agent.id).filter((task) => task.status === "doing").length, 0);
    const commsHeat = state.chats.reduce((total, chat) => total + computeChatSignal(chat).count, 0);

    return {
      command: {
        tone: commandLoad >= 2 ? "hot" : commandLoad === 1 ? "warm" : "cool",
        text: `${commandLoad} active managers`,
      },
      build: {
        tone: buildLoad >= 4 ? "hot" : buildLoad >= 2 ? "warm" : "cool",
        text: `${buildLoad} active builds`,
      },
      comms: {
        tone: commsHeat >= 18 ? "hot" : commsHeat >= 8 ? "warm" : "cool",
        text: `${signalSummary.roomCount || state.chats.length} rooms online`,
      },
    };
  }

  function isPromotedAgent(agentId) {
    return state.signals.promotedAgentIds.includes(String(agentId || ""));
  }

  function isBlockedAgent(agentId) {
    return state.signals.blockedAgentIds.includes(String(agentId || ""));
  }

  function getAgentVisualProfile(agent) {
    const orderedIds = [...state.agents]
      .map((entry) => String(entry.id || entry.name || ""))
      .sort((left, right) => left.localeCompare(right));
    const ordinal = Math.max(0, orderedIds.indexOf(String(agent.id || agent.name || "")));
    const seed = hashSeed(agent.progression?.spriteSeed || agent.id || agent.name);
    return {
      spriteIndex: ordinal % 6,
      hue: ((ordinal * 31) + (seed % 19)) % 360,
      accentHue: ((ordinal * 53) + 24) % 360,
      badge: ["CEO", "OPS", "UX", "SYS", "WEB", "AI", "PM", "DEV", "RUN", "ART", "QA", "LAB"][ordinal % 12],
      mirrored: ordinal % 2 === 1,
    };
  }

  function characterSpritePath(agent) {
    return `./assets/pixel-agents/assets/characters/char_${getAgentVisualProfile(agent).spriteIndex}.png`;
  }

  function characterHue(agent) {
    return getAgentVisualProfile(agent).hue;
  }

  function getAgentSpriteFrame(agent, motion = null) {
    const facing = motion?.facing || (getAgentVisualProfile(agent).mirrored ? "left" : "down");
    const rowMap = {
      down: 0,
      left: 1,
      right: 2,
      up: 3,
    };
    const intent = String(motion?.intent || "").toLowerCase();
    const colMap = {
      idle: 1,
      waiting: 0,
      blocked: 2,
      active: 1,
      building: 3,
      syncing: 4,
      social: 4,
      command: 5,
      reviewing: 0,
      roam: 1,
    };
    return {
      x: Math.max(0, Math.min(6, colMap[intent] ?? 1)),
      y: Math.max(0, Math.min(5, rowMap[facing] ?? 0)),
    };
  }

  function getSpriteStyle(agent, motion = null, scale = 5) {
    const frame = getAgentSpriteFrame(agent, motion);
    const frameSize = 16 * scale;
    return [
      `background-image:url('${characterSpritePath(agent)}')`,
      `background-size:${112 * scale}px ${96 * scale}px`,
      `background-position:-${frame.x * frameSize}px -${frame.y * frameSize}px`,
      `width:${frameSize}px`,
      `height:${frameSize}px`,
    ].join(";");
  }

  function getAgentNotification(agent) {
    const pulse = (state.signals.pulseEvents || []).find((entry) => entry.agentId === agent.id);
    if (pulse?.title) {
      return {
        text: pulse.title,
        tone: String(pulse.type || "info").toLowerCase(),
      };
    }
    if (isPromotedAgent(agent.id)) {
      return { text: "Promotion ready", tone: "promotion" };
    }
    if (isBlockedAgent(agent.id)) {
      return { text: "Needs help", tone: "blocker" };
    }
    const behavior = behaviorStateForAgent(agent.id);
    if (behavior?.roomTitle && behavior?.targetZone === "comms") {
      return { text: behavior.roomTitle, tone: "room" };
    }
    if (behavior?.reason) {
      return {
        text: String(behavior.reason).replace(/\s+/g, " ").trim().slice(0, 28),
        tone: String(behavior.behavior || "info").toLowerCase(),
      };
    }
    const doingCount = tasksForAgent(agent.id).filter((task) => task.status === "doing").length;
    if (doingCount > 1) {
      return { text: `${doingCount} active tasks`, tone: "active" };
    }
    return null;
  }

  function tileAssetPath(tileType) {
    if (tileType === TILE_TYPES.WALL) {
      return "./assets/pixel-agents/assets/walls/wall_0.png";
    }
    const floorIndex = Math.max(0, Math.min(8, Number(tileType) - 1));
    return `./assets/pixel-agents/assets/floors/floor_${floorIndex}.png`;
  }

  function resolveFurnitureAsset(type) {
    if (!state.furnitureCatalog) return null;
    const mirrored = String(type).endsWith(":left");
    const cleanType = String(type).replace(":left", "");
    const asset = state.furnitureCatalog[cleanType];
    if (!asset) return null;
    return {
      ...asset,
      mirrored: mirrored || Boolean(asset.mirrorSide && cleanType.endsWith("_SIDE")),
      path: `./assets/pixel-agents/assets/furniture/${asset.file}`,
    };
  }

  function getAgentPlacements() {
    const placements = new Map();
    const executives = state.agents
      .filter((agent) => agent.role === "executive")
      .sort((left, right) => Number(Boolean(right.isManager)) - Number(Boolean(left.isManager)));
    const coders = state.agents.filter((agent) => agent.role === "coder");
    const runners = state.agents.filter((agent) => agent.role !== "executive" && agent.role !== "coder");
    [
      [executives, roleAnchors.executive],
      [coders, roleAnchors.coder],
      [runners, roleAnchors.runner],
    ].forEach(([agents, anchors]) => {
      agents.forEach((agent, index) => {
        const anchor = anchors[index % anchors.length];
        placements.set(agent.id, anchor);
      });
    });
    return placements;
  }

  function openChatShortcut(chatId) {
    if (!chatId) return;
    const payload = {
      type: "kirapolis:open-chat",
      chatId,
    };
    if (window.top && window.top !== window) {
      window.top.postMessage(payload, "*");
      return;
    }
    window.location.href = `/app?tab=chat&chatId=${encodeURIComponent(chatId)}`;
  }

  function openPreviewShortcut(payload = {}) {
    const message = {
      type: "kirapolis:open-preview",
      ...payload,
    };
    if (window.top && window.top !== window) {
      window.top.postMessage(message, "*");
      return;
    }
    window.location.href = "/app?tab=files";
  }

  function officePixel(col) {
    return col * TILE_SIZE * DISPLAY_SCALE;
  }

  function computeLayoutBounds(layout) {
    const bounds = {
      minCol: layout.cols,
      maxCol: 0,
      minRow: layout.rows,
      maxRow: 0,
    };
    for (let row = 0; row < layout.rows; row += 1) {
      for (let col = 0; col < layout.cols; col += 1) {
        const tileType = layout.tiles[row * layout.cols + col];
        if (tileType === TILE_TYPES.VOID) continue;
        bounds.minCol = Math.min(bounds.minCol, col);
        bounds.maxCol = Math.max(bounds.maxCol, col);
        bounds.minRow = Math.min(bounds.minRow, row);
        bounds.maxRow = Math.max(bounds.maxRow, row);
      }
    }
    return bounds;
  }

  function sceneLeft(col) {
    return officePixel(col - state.layoutBounds.minCol);
  }

  function sceneTop(row) {
    return officePixel(row - state.layoutBounds.minRow);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeVector(dx, dy) {
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  }

  function doorAnchor(index) {
    return { col: 19, row: 12 + index * 2 };
  }

  function pickChatForAgent(agent) {
    if (!state.chats.length) return null;
    const hotRooms = state.signals.hotRooms || [];
    const activeRooms = hotRooms.filter((entry) => entry.tone === "hot" || entry.tone === "warm");
    const rankedRooms = activeRooms.length
      ? activeRooms.map((entry) => chatById(entry.id)).filter(Boolean)
      : state.chats;
    if (!rankedRooms.length) return state.chats[0] || null;
    if (agent.role === "executive") {
      return rankedRooms[0];
    }
    if (agent.role === "runner") {
      return rankedRooms[Math.min(1, rankedRooms.length - 1)] || rankedRooms[0];
    }
    const seed = hashSeed(`${agent.id}:${state.signals.syncPulseToken || rankedRooms.length}`);
    return rankedRooms[seed % rankedRooms.length];
  }

  function anchorWithJitter(anchor, seedKey, radius = 0.45) {
    const seed = hashSeed(seedKey);
    const x = ((seed % 1000) / 1000 - 0.5) * radius;
    const y = (((Math.floor(seed / 1000)) % 1000) / 1000 - 0.5) * radius;
    return {
      col: anchor.col + x,
      row: anchor.row + y,
    };
  }

  function deriveAgentIntent(agent, placements) {
    const behavior = behaviorStateForAgent(agent.id);
    const anchor = placements.get(agent.id) || { col: 2, row: 12 };
    const doingCount = tasksForAgent(agent.id).filter((task) => task.status === "doing").length;
    const blockedCount = tasksForAgent(agent.id).filter((task) => task.status === "blocked").length;
    const assignedChat = pickChatForAgent(agent);
    const chatIndex = assignedChat ? Math.max(0, state.chats.findIndex((chat) => chat.id === assignedChat.id)) : 0;
    const hot = assignedChat ? computeChatSignal(assignedChat).tone !== "cool" : false;

    if (behavior) {
      if (behavior.targetZone === "ops") {
        const target = anchorWithJitter(utilityHotspots.find((entry) => entry.id === "ops") || { col: 10, row: 11 }, `${agent.id}:ops`, 0.7);
        return { ...target, mode: behavior.behavior || "blocked", reason: behavior.reason || "Ops desk", chatId: behavior.roomId || "" };
      }
      if (behavior.targetZone === "notes") {
        const target = anchorWithJitter(utilityHotspots.find((entry) => entry.id === "notes") || { col: 19, row: 21 }, `${agent.id}:notes`, 0.8);
        return { ...target, mode: behavior.behavior || "waiting", reason: behavior.reason || "Notes wall", chatId: behavior.roomId || "" };
      }
      if (behavior.targetZone === "preview") {
        const target = anchorWithJitter(utilityHotspots.find((entry) => entry.id === "preview") || { col: 10, row: 21 }, `${agent.id}:preview`, 0.9);
        return { ...target, mode: behavior.behavior || "reviewing", reason: behavior.reason || "Workspace gate", chatId: behavior.roomId || "" };
      }
      if (behavior.targetZone === "comms" && behavior.roomId) {
        const linkedIndex = Math.max(0, state.chats.findIndex((chat) => chat.id === behavior.roomId));
        const target = anchorWithJitter(doorAnchor(linkedIndex), `${agent.id}:room:${behavior.roomId}`, 0.9);
        return { ...target, mode: behavior.behavior || "social", reason: behavior.reason || behavior.roomTitle || "Comms", chatId: behavior.roomId };
      }
    }

    if (blockedCount) {
      const target = anchorWithJitter(utilityHotspots.find((entry) => entry.id === "ops") || { col: 10, row: 11 }, `${agent.id}:blocked`, 0.7);
      return { ...target, mode: "blocked", reason: "blocked work", chatId: assignedChat?.id || "" };
    }
    if (agent.role === "executive") {
      if (hot && assignedChat) {
        const target = anchorWithJitter(doorAnchor(chatIndex), `${agent.id}:room:${assignedChat.id}`, 0.8);
        return { ...target, mode: "social", reason: assignedChat.title, chatId: assignedChat.id };
      }
      const target = anchorWithJitter(anchor, `${agent.id}:command`, 0.75);
      return { ...target, mode: "command", reason: "command desk", chatId: assignedChat?.id || "" };
    }
    if (agent.role === "coder") {
      if (doingCount > 0) {
        const target = anchorWithJitter(anchor, `${agent.id}:build:${doingCount}`, 1.15);
        return { ...target, mode: "building", reason: `${doingCount} active tasks`, chatId: assignedChat?.id || "" };
      }
      if (hot && assignedChat) {
        const chatTarget = anchorWithJitter(doorAnchor(chatIndex), `${agent.id}:sync:${assignedChat.id}`, 0.95);
        return { ...chatTarget, mode: "sync", reason: assignedChat.title, chatId: assignedChat.id };
      }
      const previewTarget = anchorWithJitter(utilityHotspots.find((entry) => entry.id === "preview") || { col: 10, row: 21 }, `${agent.id}:preview`, 1.2);
      return { ...previewTarget, mode: "review", reason: "workspace gate", chatId: assignedChat?.id || "" };
    }
    if (hot && assignedChat) {
      const socialBase = socialAnchors[chatIndex % socialAnchors.length];
      const socialTarget = anchorWithJitter(socialBase, `${agent.id}:social:${assignedChat.id}`, 1.0);
      return { ...socialTarget, mode: "social", reason: assignedChat.title, chatId: assignedChat.id };
    }
    if (isAgentWaiting(agent)) {
      const noteTarget = anchorWithJitter(utilityHotspots.find((entry) => entry.id === "notes") || { col: 19, row: 21 }, `${agent.id}:notes`, 0.9);
      return { ...noteTarget, mode: "waiting", reason: "notes wall", chatId: assignedChat?.id || "" };
    }
    const roamTarget = anchorWithJitter(anchor, `${agent.id}:roam:${Date.now() >> 14}`, 1.1);
    return { ...roamTarget, mode: "roam", reason: "floor patrol", chatId: assignedChat?.id || "" };
  }

  function ensureMotionState(agentId, pixelLeft, pixelTop) {
    const existing = state.motion.agents[agentId];
    if (existing) return existing;
    const motion = {
      x: pixelLeft,
      y: pixelTop,
      targetX: pixelLeft,
      targetY: pixelTop,
      speed: 48,
      intent: "idle",
      reason: "",
      facing: "down",
    };
    state.motion.agents[agentId] = motion;
    return motion;
  }

  function syncAgentMotions() {
    const placements = getAgentPlacements();
    const liveIds = new Set();
    state.agents.forEach((agent) => {
      const anchor = placements.get(agent.id) || { col: 2, row: 12 };
      const pixelLeft = sceneLeft(anchor.col) + 4;
      const pixelTop = sceneTop(anchor.row) - 34;
      const motion = ensureMotionState(agent.id, pixelLeft, pixelTop);
      const intent = deriveAgentIntent(agent, placements);
      motion.targetX = sceneLeft(intent.col) + 4;
      motion.targetY = sceneTop(intent.row) - 34;
      motion.speed = intent.mode === "blocked" ? 20 : intent.mode === "social" ? 42 : intent.mode === "building" ? 58 : 34;
      motion.intent = intent.mode;
      motion.reason = intent.reason;
      liveIds.add(agent.id);
    });
    Object.keys(state.motion.agents).forEach((agentId) => {
      if (!liveIds.has(agentId)) {
        delete state.motion.agents[agentId];
      }
    });
  }

  function applyAgentMotion(agentId) {
    const node = document.querySelector(`.agent-node[data-agent-id="${CSS.escape(agentId)}"]`);
    const motion = state.motion.agents[agentId];
    if (!node || !motion) return;
    node.style.left = `${motion.x}px`;
    node.style.top = `${motion.y}px`;
    node.dataset.intent = motion.intent || "idle";
    node.dataset.facing = motion.facing || "down";
    const agent = agentById(agentId);
    node.title = motion.reason ? `${agent?.name || agentId}: ${motion.reason}` : `${agent?.name || agentId}`;
    const meta = node.querySelector(".agent-meta");
    if (meta) {
      meta.dataset.reason = motion.reason || "";
    }
  }

  function tickMotion(now) {
    if (!state.motion.lastTick) {
      state.motion.lastTick = now;
    }
    const delta = Math.min(0.05, (now - state.motion.lastTick) / 1000);
    state.motion.lastTick = now;
    Object.entries(state.motion.agents).forEach(([agentId, motion]) => {
      const dx = motion.targetX - motion.x;
      const dy = motion.targetY - motion.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.5) {
        const direction = normalizeVector(dx, dy);
        const step = Math.min(distance, motion.speed * delta);
        motion.x += direction.x * step;
        motion.y += direction.y * step;
        motion.facing = Math.abs(dx) > Math.abs(dy)
          ? (dx >= 0 ? "right" : "left")
          : (dy >= 0 ? "down" : "up");
      }
      applyAgentMotion(agentId);
    });
    state.motion.rafId = window.requestAnimationFrame(tickMotion);
  }

  function startMotionLoop() {
    if (state.motion.rafId) {
      window.cancelAnimationFrame(state.motion.rafId);
    }
    state.motion.lastTick = 0;
    state.motion.rafId = window.requestAnimationFrame(tickMotion);
  }

  function refreshMotionTargets() {
    if (!state.officeLayout || !state.furnitureCatalog) return;
    syncAgentMotions();
    if (state.selectedAgentId) {
      renderAgentCard();
    }
  }

  function setDrawerView(view) {
    state.drawerView = view;
    const titleMap = {
      agent: "Agent Card",
      rooms: "Room Control",
      preview: "Workspace Site",
      files: "Workspace Files",
      notes: "Project Notes",
      ops: "Operations",
    };
    $("office-drawer-title").textContent = titleMap[view] || "Live Panel";
    ["agent", "rooms", "preview", "files", "notes", "ops"].forEach((name) => {
      $(`office-view-${name}`)?.classList.toggle("hidden", name !== view);
    });
    document.querySelectorAll("[data-drawer-view]").forEach((node) => {
      node.classList.toggle("active", node.getAttribute("data-drawer-view") === view);
    });
    $("office-drawer")?.classList.remove("hidden");
  }

  async function refreshWorkspaceIndexes() {
    const [filesResponse, notesResponse] = await Promise.all([
      fetch("/api/workspace/files/index"),
      fetch("/api/workspace/notes/index"),
    ]);
    const filesData = await filesResponse.json();
    const notesData = await notesResponse.json();
    state.workspace.files = filesData.items || [];
    state.workspace.notes = notesData.items || [];
  }

  function scoreWorkspaceItem(item, agent) {
    if (!agent) return 0;
    const haystack = `${item.path || ""} ${item.preview || ""}`.toLowerCase();
    const tokens = [agent.id, agent.name, agent.role, ...(agent.skills || [])]
      .filter(Boolean)
      .flatMap((value) => String(value).toLowerCase().split(/[^a-z0-9]+/))
      .filter((token) => token.length >= 3);
    return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
  }

  function getWorkspaceItems(kind) {
    const items = kind === "notes" ? [...state.workspace.notes] : [...state.workspace.files];
    const agent = agentById(state.selectedAgentId);
    return items
      .map((item) => ({ ...item, _score: scoreWorkspaceItem(item, agent) }))
      .sort((left, right) => {
        if (right._score !== left._score) return right._score - left._score;
        return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
      })
      .slice(0, 12);
  }

  function normalizeWorkspacePath(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  function getWorkspaceDir(kind) {
    return normalizeWorkspacePath(state.workspace[`${kind}Dir`]);
  }

  function getWorkspaceMode(kind) {
    return state.workspace[`${kind}Mode`] || "list";
  }

  function setWorkspaceMode(kind, mode) {
    state.workspace[`${kind}Mode`] = mode;
  }

  function setWorkspaceDir(kind, dir) {
    state.workspace[`${kind}Dir`] = normalizeWorkspacePath(dir);
    setWorkspaceMode(kind, "list");
  }

  function getWorkspaceSelectedPath(kind) {
    return kind === "notes" ? state.workspace.selectedNote : state.workspace.selectedFile;
  }

  function setWorkspaceSelectedPath(kind, value) {
    if (kind === "notes") {
      state.workspace.selectedNote = value;
      return;
    }
    state.workspace.selectedFile = value;
  }

  function formatWorkspaceDirLabel(kind) {
    const currentDir = getWorkspaceDir(kind);
    if (!currentDir) {
      return kind === "notes" ? "Notes Root" : "Workspace Root";
    }
    return currentDir;
  }

  function getWorkspaceExplorerEntries(kind) {
    const items = getWorkspaceItems(kind);
    const currentDir = getWorkspaceDir(kind);
    const prefix = currentDir ? `${currentDir}/` : "";
    const folders = new Map();
    const files = [];
    items.forEach((item) => {
      const normalized = normalizeWorkspacePath(item.path);
      if (prefix && !normalized.startsWith(prefix)) {
        return;
      }
      const remainder = prefix ? normalized.slice(prefix.length) : normalized;
      if (!remainder) {
        return;
      }
      const segments = remainder.split("/");
      if (segments.length > 1) {
        const folderName = segments[0];
        const folderPath = normalizeWorkspacePath(prefix ? `${prefix}${folderName}` : folderName);
        if (!folders.has(folderPath)) {
          folders.set(folderPath, {
            type: "folder",
            name: folderName,
            path: folderPath,
            count: 0,
          });
        }
        folders.get(folderPath).count += 1;
        return;
      }
      files.push({
        type: "file",
        name: item.name || segments[0],
        path: normalized,
        preview: item.preview || "",
        updatedAt: Number(item.updatedAt || 0),
      });
    });
    return [
      ...[...folders.values()].sort((left, right) => left.name.localeCompare(right.name)),
      ...files.sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
        return left.name.localeCompare(right.name);
      }),
    ];
  }

  async function openWorkspaceEntry(kind, relativePath) {
    const response = await fetch(`/api/workspace/read?path=${encodeURIComponent(relativePath)}`);
    const data = await response.json();
    setWorkspaceSelectedPath(kind, relativePath);
    setWorkspaceMode(kind, "detail");
    if (kind === "notes") {
      state.workspace.noteContent = data.content || "No note content.";
    } else {
      state.workspace.fileContent = data.content || "No file content.";
    }
    renderWorkspaceLists();
  }

  function goBackWorkspace(kind) {
    if (getWorkspaceMode(kind) === "detail") {
      setWorkspaceMode(kind, "list");
      renderWorkspaceLists();
      return;
    }
    const currentDir = getWorkspaceDir(kind);
    if (!currentDir) {
      return;
    }
    const parent = currentDir.includes("/") ? currentDir.split("/").slice(0, -1).join("/") : "";
    setWorkspaceDir(kind, parent);
    renderWorkspaceLists();
  }

  function renderWorkspaceLists() {
    ["files", "notes"].forEach((kind) => {
      const target = $(`office-${kind}-browser`);
      const pathLabel = $(`office-${kind}-path`);
      const backButton = $(`office-${kind}-back`);
      if (!target) return;
      const mode = getWorkspaceMode(kind);
      const currentDir = getWorkspaceDir(kind);
      const selectedPath = getWorkspaceSelectedPath(kind);
      if (pathLabel) {
        pathLabel.textContent = mode === "detail"
          ? (selectedPath ? selectedPath.split("/").pop() || selectedPath : formatWorkspaceDirLabel(kind))
          : formatWorkspaceDirLabel(kind);
      }
      if (backButton) {
        backButton.classList.toggle("hidden", mode === "list" && !currentDir);
      }
      if (mode === "detail" && selectedPath) {
        target.innerHTML = `
          <div class="drawer-detail">
            <div class="drawer-detail-toolbar">
              <div>
                <div class="panel-label">${kind === "notes" ? "Note Viewer" : "File Viewer"}</div>
                <strong class="drawer-detail-title">${escapeHtml(selectedPath.split("/").pop() || selectedPath)}</strong>
                <div class="drawer-detail-path">${escapeHtml(selectedPath)}</div>
              </div>
            </div>
            <pre id="office-${kind === "notes" ? "note" : "file"}-viewer" class="drawer-viewer">${escapeHtml(
              kind === "notes" ? state.workspace.noteContent || "No note content." : state.workspace.fileContent || "No file content."
            )}</pre>
          </div>
        `;
        return;
      }
      const entries = getWorkspaceExplorerEntries(kind);
      target.innerHTML = entries.length ? entries.map((entry) => {
        if (entry.type === "folder") {
          return `
            <button type="button" class="drawer-entry drawer-folder" data-workspace-kind="${kind}" data-workspace-dir="${escapeHtml(entry.path)}">
              <div class="drawer-entry-meta">
                <strong>${escapeHtml(entry.name)}</strong>
                <span>${escapeHtml(String(entry.count || 0))} items</span>
              </div>
              <span class="drawer-entry-kind">Folder</span>
            </button>
          `;
        }
        return `
          <button type="button" class="drawer-entry drawer-file-open ${selectedPath === entry.path ? "active" : ""}" data-workspace-kind="${kind}" data-workspace-path="${escapeHtml(entry.path)}">
            <div class="drawer-entry-meta">
              <strong>${escapeHtml(entry.name)}</strong>
              <span>${escapeHtml(entry.path)}</span>
            </div>
            <span class="drawer-entry-kind">${kind === "notes" ? "Note" : "File"}</span>
          </button>
        `;
      }).join("") : `<div class="drawer-empty">No ${kind} found in this folder yet.</div>`;
    });
    document.querySelectorAll("[data-workspace-path]").forEach((node) => {
      node.addEventListener("click", async () => {
        const kind = node.getAttribute("data-workspace-kind");
        const targetPath = node.getAttribute("data-workspace-path");
        if (!kind || !targetPath) return;
        await openWorkspaceEntry(kind, targetPath);
        setDrawerView(kind);
      });
    });
    document.querySelectorAll("[data-workspace-dir]").forEach((node) => {
      node.addEventListener("click", () => {
        const kind = node.getAttribute("data-workspace-kind");
        const targetDir = node.getAttribute("data-workspace-dir");
        if (!kind || targetDir == null) return;
        setWorkspaceDir(kind, targetDir);
        renderWorkspaceLists();
        setDrawerView(kind);
      });
    });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => null);
      return;
    }
    document.documentElement.requestFullscreen?.().catch(() => null);
  }

  async function ensureOfficeAssets() {
    if (state.officeLayout && state.furnitureCatalog) {
      return;
    }
    const [layoutResponse, catalogResponse] = await Promise.all([
      fetch("./assets/pixel-agents/assets/default-layout-1.json"),
      fetch("./assets/pixel-agents/furniture-catalog.json"),
    ]);
    state.officeLayout = await layoutResponse.json();
    state.furnitureCatalog = await catalogResponse.json();
    state.layoutBounds = computeLayoutBounds(state.officeLayout);
  }

  function buildSceneShell() {
    const map = $("office-map");
    map.innerHTML = "";

    const viewport = document.createElement("div");
    viewport.className = "office-map-viewport";

    const scene = document.createElement("div");
    scene.className = "office-scene";
    const rawWidth = officePixel(state.layoutBounds.maxCol - state.layoutBounds.minCol + 1);
    const rawHeight = officePixel(state.layoutBounds.maxRow - state.layoutBounds.minRow + 1);
    scene.style.width = `${rawWidth}px`;
    scene.style.height = `${rawHeight}px`;
    if (backgroundMode || embedMode) {
      const viewportWidth = Math.max(1, map.clientWidth || window.innerWidth || rawWidth);
      const viewportHeight = Math.max(1, map.clientHeight || window.innerHeight || rawHeight);
      const fitScale = Math.min(viewportWidth / rawWidth, viewportHeight / rawHeight);
      const coverScale = Math.max(viewportWidth / rawWidth, viewportHeight / rawHeight);
      const scaleFactor = backgroundMode
        ? Math.max(1, coverScale)
        : Math.max(1, fitScale);
      scene.style.transformOrigin = "center center";
      scene.style.transform = `scale(${scaleFactor})`;
    }

    viewport.appendChild(scene);
    map.appendChild(viewport);
    return { scene, viewport };
  }

  function renderTiles(scene) {
    const { cols, rows, tiles } = state.officeLayout;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const tileType = tiles[row * cols + col];
        if (tileType === TILE_TYPES.VOID) {
          continue;
        }
        const tile = document.createElement("div");
        tile.className = `office-tile ${tileType === TILE_TYPES.WALL ? "wall" : "floor"}`;
        tile.style.left = `${sceneLeft(col)}px`;
        tile.style.top = `${sceneTop(row)}px`;
        tile.style.width = `${officePixel(1)}px`;
        tile.style.height = `${officePixel(1)}px`;
        tile.style.backgroundImage = `url("${tileAssetPath(tileType)}")`;
        scene.appendChild(tile);
      }
    }
  }

  function renderFurniture(scene) {
    const furniture = [...(state.officeLayout.furniture || [])].sort((left, right) => {
      const a = (left.row || 0) + 1;
      const b = (right.row || 0) + 1;
      return a - b;
    });

    furniture.forEach((item) => {
      const asset = resolveFurnitureAsset(item.type);
      if (!asset) return;
      const node = document.createElement("img");
      node.className = "furniture-node";
      node.alt = item.type;
      node.src = asset.path;
      node.style.left = `${sceneLeft(item.col)}px`;
      node.style.top = `${sceneTop(item.row) + officePixel(asset.footprintH) - asset.height * DISPLAY_SCALE}px`;
      node.style.width = `${asset.width * DISPLAY_SCALE}px`;
      node.style.height = `${asset.height * DISPLAY_SCALE}px`;
      node.style.zIndex = String(20 + item.row);
      if (asset.mirrored) {
        node.style.transform = "scaleX(-1)";
      }
      scene.appendChild(node);
    });
  }

  function renderOverlayLabels(scene) {
    const metrics = getZoneMetrics();
    overlayLabels.forEach((entry) => {
      const key = entry.label.startsWith("Command") ? "command" : entry.label.startsWith("Build") ? "build" : "comms";
      const metric = metrics[key];
      const aura = document.createElement("div");
      aura.className = `zone-aura ${metric.tone}`;
      aura.style.left = `${sceneLeft(entry.col) - 18}px`;
      aura.style.top = `${sceneTop(entry.row) - 18}px`;
      aura.style.width = `${officePixel(entry.width) + 36}px`;
      aura.style.height = `${officePixel(5)}px`;
      scene.appendChild(aura);

      const node = document.createElement("div");
      node.className = "office-overlay-label";
      node.innerHTML = `
        <span>${entry.label}</span>
        <strong>${metric.text}</strong>
      `;
      node.style.left = `${sceneLeft(entry.col)}px`;
      node.style.top = `${sceneTop(entry.row) - 28}px`;
      node.style.width = `${officePixel(entry.width)}px`;
      scene.appendChild(node);
    });
  }

  function renderDeskSignals(scene) {
    const placements = getAgentPlacements();
    state.agents.forEach((agent) => {
      const anchor = placements.get(agent.id);
      if (!anchor) return;
      const doingCount = tasksForAgent(agent.id).filter((task) => task.status === "doing").length;
      const blockedCount = tasksForAgent(agent.id).filter((task) => task.status === "blocked").length;
      const tone = blockedCount ? "hot" : doingCount > 1 ? "warm" : isAgentActive(agent) ? "cool" : "idle";
      const pulseClass = isPromotedAgent(agent.id) ? "sync-promo" : isBlockedAgent(agent.id) ? "sync-blocked" : "";

      const beacon = document.createElement("div");
      beacon.className = `desk-beacon ${tone} ${pulseClass}`;
      beacon.style.left = `${sceneLeft(anchor.col) + 6}px`;
      beacon.style.top = `${sceneTop(anchor.row) + 8}px`;
      beacon.style.zIndex = String(65 + anchor.row);
      beacon.innerHTML = `
        <span class="desk-dot"></span>
        <span class="desk-copy">${blockedCount ? `${blockedCount} blocked` : doingCount ? `${doingCount} active` : isAgentWaiting(agent) ? "waiting" : "stable"}</span>
      `;
      scene.appendChild(beacon);
    });
  }

  function renderSocialLinks(scene) {
    const placements = getAgentPlacements();
    (state.signals.socialLinks || []).slice(0, 8).forEach((link) => {
      const [fromId, toId] = link.agentIds || [];
      if (!fromId || !toId) return;
      const fromAgent = agentById(fromId);
      const toAgent = agentById(toId);
      if (!fromAgent || !toAgent) return;
      const fromIntent = deriveAgentIntent(fromAgent, placements);
      const toIntent = deriveAgentIntent(toAgent, placements);
      if (!fromIntent || !toIntent) return;
      const x1 = sceneLeft(fromIntent.col) + 4;
      const y1 = sceneTop(fromIntent.row) - 24;
      const x2 = sceneLeft(toIntent.col) + 4;
      const y2 = sceneTop(toIntent.row) - 24;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const node = document.createElement("div");
      node.className = "social-link";
      node.style.left = `${x1}px`;
      node.style.top = `${y1}px`;
      node.style.width = `${length}px`;
      node.style.transform = `rotate(${angle}rad)`;
      node.style.opacity = String(clamp(Number(link.strength || 0.5), 0.24, 0.85));
      scene.appendChild(node);
    });
  }

  function renderPulseBursts(scene) {
    const ambient = state.signals.ambientState || null;
    const latestPulse = (state.signals.pulseEvents || [])[0] || null;
    if (!ambient && !latestPulse) return;
    const pulseType = String(latestPulse?.type || ambient?.mode || "steady");
    const anchor = pulseType === "promotion"
      ? { col: 10, row: 11 }
      : pulseType === "completion"
        ? { col: 10, row: 21 }
        : pulseType === "blocker"
          ? { col: 19, row: 21 }
          : pulseType === "surge"
            ? { col: 19, row: 14 }
            : { col: 13, row: 14 };
    const node = document.createElement("div");
    node.className = `pulse-burst ${escapeHtml(pulseType)}`;
    node.style.left = `${sceneLeft(anchor.col)}px`;
    node.style.top = `${sceneTop(anchor.row)}px`;
    scene.appendChild(node);
  }

  function renderAmbientState(scene) {
    const ambient = state.signals.ambientState || { mode: "steady", label: "Steady", detail: "The loop is stable." };
    const director = state.signals.directorMode || null;
    scene.dataset.ambient = ambient.mode || "steady";
    scene.dataset.director = director?.scenarios?.[0]?.kind || "steady-loop";
    setBanner(director ? `${director.label}: ${director.recommendation}` : `${ambient.label}: ${ambient.detail}`);
  }

  function renderAgents(scene) {
    const placements = getAgentPlacements();
    state.agents.forEach((agent) => {
      const anchor = placements.get(agent.id) || { col: 2, row: 12 };
      const doingCount = tasksForAgent(agent.id).filter((task) => task.status === "doing").length;
      const blockedCount = tasksForAgent(agent.id).filter((task) => task.status === "blocked").length;
      const stateClass = blockedCount || isBlockedAgent(agent.id) ? "blocked" : isAgentWaiting(agent) ? "waiting" : isAgentActive(agent) ? "active-state" : "idle-state";
      const syncClass = isPromotedAgent(agent.id) ? "sync-promo" : isBlockedAgent(agent.id) ? "sync-blocked" : "";
      const node = document.createElement("button");
      node.type = "button";
      node.className = `agent-node walking ${state.selectedAgentId === agent.id ? "active" : ""} ${stateClass} ${syncClass}`;
      node.dataset.agentId = agent.id;
      node.dataset.intent = "idle";
      node.dataset.facing = "down";
      node.setAttribute("aria-label", `${agent.name} level ${agent.progression?.level || 1}`);
      node.title = `${agent.name}`;
      node.style.left = `${sceneLeft(anchor.col) + 4}px`;
      node.style.top = `${sceneTop(anchor.row) - 34}px`;
      node.style.zIndex = String(100 + anchor.row);
      node.style.setProperty("--delay", `${(hashSeed(agent.id) % 7) * 0.12}s`);
      const visual = getAgentVisualProfile(agent);
      const motion = state.motion.agents[agent.id] || null;
      const notice = getAgentNotification(agent);
      node.style.setProperty("--hue", `${visual.hue}deg`);
      node.style.setProperty("--accent-hue", `${visual.accentHue}deg`);
      node.dataset.variant = visual.badge.toLowerCase();
      if (visual.mirrored) {
        node.dataset.facing = "left";
      }
      node.innerHTML = `
        ${notice ? `<div class="agent-notice ${escapeHtml(notice.tone)}">${escapeHtml(notice.text)}</div>` : ""}
        <div class="sprite-stack">
          <span class="sprite-frame" role="img" aria-label="${escapeHtml(agent.name)} sprite" style="${getSpriteStyle(agent, motion, 5)}"></span>
          <span class="sprite-accent"></span>
          <span class="sprite-badge">${escapeHtml(visual.badge)}</span>
        </div>
        <div class="agent-label">${escapeHtml(agent.name)}</div>
        <div class="agent-meta">Lv ${escapeHtml(agent.progression?.level || 1)} <span class="stars">${starMarkup(agent.progression?.stars || 1)}</span> <span class="agent-state-chip">${blockedCount ? "blocked" : doingCount ? `${doingCount}x` : isAgentActive(agent) ? "live" : "idle"}</span></div>
      `;
      node.addEventListener("click", () => {
        hideMenu();
        selectAgent(agent.id);
        setDrawerView("agent");
      });
      node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        selectAgent(agent.id);
        openMenu(agent.id, event.clientX, event.clientY);
      });
      node.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch") return;
        const timer = window.setTimeout(() => {
          selectAgent(agent.id);
          openMenu(agent.id, event.clientX || sceneLeft(anchor.col), event.clientY || sceneTop(anchor.row));
        }, 450);
        const clear = () => {
          window.clearTimeout(timer);
          node.removeEventListener("pointerup", clear);
          node.removeEventListener("pointercancel", clear);
        };
        node.addEventListener("pointerup", clear);
        node.addEventListener("pointercancel", clear);
      });
      scene.appendChild(node);
    });
  }

  function renderDoors(scene) {
    state.chats.slice(0, 4).forEach((chat, index) => {
      const signal = computeChatSignal(chat);
      const door = document.createElement("button");
      door.type = "button";
      door.className = `door-node pixel-door ${signal.tone} ${signal.tone === "hot" ? "sync-pulse" : ""}`;
      door.style.left = `${sceneLeft(19)}px`;
      door.style.top = `${sceneTop(12 + index * 2)}px`;
      door.style.zIndex = String(70 + index);
      door.setAttribute("aria-label", `Open ${chat.title}`);
      door.innerHTML = `
        <span class="pixel-door-slab"></span>
        <span class="door-badge">${signal.label}</span>
        <span class="door-label">${escapeHtml(chat.title)}${signal.count ? ` <em>${signal.count}</em>` : ""}</span>
      `;
      door.addEventListener("click", () => {
        state.selectedChatId = chat.id;
        renderRoomPreview();
        setDrawerView("rooms");
        setBanner(`${chat.title} is ready.`);
      });
      scene.appendChild(door);
    });
  }

  function renderUtilityHotspots(scene) {
    utilityHotspots.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "utility-hotspot";
      button.style.left = `${sceneLeft(entry.col)}px`;
      button.style.top = `${sceneTop(entry.row)}px`;
      button.style.zIndex = "110";
      button.innerHTML = `
        <strong>${escapeHtml(entry.label)}</strong>
        <span>${escapeHtml(entry.detail)}</span>
      `;
      button.addEventListener("click", () => {
        if (entry.view === "preview") {
          $("office-preview-frame").src = getPreviewUrl();
        }
        setDrawerView(entry.view);
        setBanner(`${entry.label} opened.`);
      });
      scene.appendChild(button);
    });
  }

  function renderMilestoneGates(scene) {
    const milestones = state.signals.milestoneBosses || [];
    milestones.forEach((entry, index) => {
      const gate = document.createElement("div");
      gate.className = `milestone-gate ${escapeHtml(entry.state || "locked")}`;
      gate.style.left = `${sceneLeft(11 + index * 2)}px`;
      gate.style.top = `${sceneTop(22)}px`;
      gate.style.zIndex = String(90 + index);
      gate.innerHTML = `
        <span class="milestone-gate-label">${escapeHtml(entry.label || "Milestone")}</span>
        <span class="milestone-gate-state">${escapeHtml(String(entry.state || "locked").toUpperCase())}</span>
      `;
      scene.appendChild(gate);
    });
  }

  function renderMap() {
    if (!state.officeLayout || !state.furnitureCatalog) return;
    const shell = buildSceneShell();
    const scene = shell.scene;
    state.motion.scene = scene;
    renderTiles(scene);
    renderFurniture(scene);
    renderOverlayLabels(scene);
    renderDeskSignals(scene);
    renderSocialLinks(scene);
    renderPulseBursts(scene);
    renderDoors(scene);
    renderUtilityHotspots(scene);
    renderMilestoneGates(scene);
    renderAgents(scene);
    renderAmbientState(scene);
    syncAgentMotions();
    Object.keys(state.motion.agents).forEach(applyAgentMotion);
  }

  function renderAgentCard() {
    const target = $("agent-card-body");
    const agent = agentById(state.selectedAgentId);
    const motion = state.motion.agents[state.selectedAgentId] || null;
    if (!agent) {
      target.textContent = "Select an agent on the office floor to see their card.";
      return;
    }
    const progression = agent.progression || {};
    const roleLabel = agent.isManager ? "Manager" : (agent.role || "agent");
    const visual = getAgentVisualProfile(agent);
    target.innerHTML = `
      <div class="agent-card">
        <div class="agent-card-top">
          <span class="agent-card-sprite" role="img" aria-label="${escapeHtml(agent.name)} sprite" style="--hue:${visual.hue}deg; --accent-hue:${visual.accentHue}deg; ${getSpriteStyle(agent, motion, 7)}"></span>
          <div>
            <div class="agent-card-name">${escapeHtml(agent.name)}</div>
            <div class="panel-copy">${escapeHtml(progression.rankLabel || roleLabel)} | ${escapeHtml(roleLabel)} | ${escapeHtml(agent.provider || "local")} | ${escapeHtml(visual.badge)}</div>
          </div>
        </div>
        <div class="agent-grid">
          <div class="agent-detail"><div class="panel-label">Stars</div><strong>${starMarkup(progression.stars || 1)}</strong></div>
          <div class="agent-detail"><div class="panel-label">Level</div><strong>${escapeHtml(progression.level || 1)}</strong></div>
          <div class="agent-detail"><div class="panel-label">XP</div><strong>${escapeHtml(progression.totalXp || 0)}</strong></div>
          <div class="agent-detail"><div class="panel-label">Completed</div><strong>${escapeHtml(progression.completedTasks || 0)}</strong></div>
        </div>
        <div class="agent-detail">
          <div class="panel-label">Level Progress</div>
          <div class="panel-copy">${escapeHtml(progression.xpIntoLevel || 0)} / ${escapeHtml(progression.xpForNextLevel || 1)} XP in current level (${levelProgress(agent)}%)</div>
        </div>
        <div class="agent-detail">
          <div class="panel-label">Notes</div>
          <div class="panel-copy">${escapeHtml(agent.notes || "No notes.")}</div>
        </div>
        <div class="agent-detail">
          <div class="panel-label">Live Intent</div>
          <div class="panel-copy">${escapeHtml(motion?.reason || "Holding position.")}</div>
        </div>
        <div class="agent-detail">
          <div class="panel-label">Tools</div>
          <div class="panel-copy">${escapeHtml((agent.tools || []).join(", ") || "No tools assigned.")}</div>
        </div>
        <div class="toolbar">
          <button type="button" class="primary" data-agent-preview="${escapeHtml(agent.id)}">Open Workspace</button>
        </div>
      </div>
    `;
    target.querySelector("[data-agent-preview]")?.addEventListener("click", () => {
      $("office-preview-frame").src = getPreviewUrl();
      setDrawerView("preview");
      setBanner(`Opened workspace for ${agent.name}.`);
    });
  }

  function renderLoopStatus() {
    const summary = state.summary || {};
    const spotlight = state.signals.spotlight || null;
    const behaviorSummary = state.signals.behaviorSummary || {};
    const autonomyLabel = summary.autonomyActive
      ? `Autonomy on${summary.autonomyIntervalMs ? ` every ${Math.round(summary.autonomyIntervalMs / 1000)}s` : ""}`
      : "Autonomy off";
    $("loop-status-body").innerHTML = `
      <div class="monitor-list">
        <div class="monitor-card"><strong>${summary.activeAgents || 0} active agents</strong><div class="panel-copy">${escapeHtml(summary.autonomyDetail || autonomyLabel)}</div></div>
        <div class="monitor-card"><strong>${summary.doingTasks || 0} in progress | ${summary.blockedTasks || 0} blocked</strong><div class="panel-copy">${summary.completedTasks || 0} completed tasks are already feeding XP into the promotion system.</div></div>
        <div class="monitor-card"><strong>${escapeHtml(autonomyLabel)}</strong><div class="panel-copy">${Object.entries(behaviorSummary).map(([key, value]) => `${value} ${key}`).join(" | ") || "No behavior summary yet"}</div></div>
        ${spotlight ? `<div class="monitor-card"><strong>${escapeHtml(spotlight.agentName || "Spotlight")}</strong><div class="panel-copy">${escapeHtml(spotlight.reason || "Current live leader.")}</div></div>` : ""}
      </div>
    `;
    $("active-count").textContent = String(summary.activeAgents || 0);
  }

  function renderMomentum() {
    const momentum = state.signals.momentum || {};
    const spotlight = state.signals.spotlight || null;
    $("momentum-body").innerHTML = `
      <div class="monitor-list">
        <div class="monitor-card">
          <strong>${escapeHtml(momentum.label || "Steady")} | ${escapeHtml(momentum.score || 0)}%</strong>
          <div class="panel-copy">${escapeHtml(momentum.recentCompletionCount || 0)} recent wins and ${escapeHtml(momentum.recentActivityCount || 0)} live actions in the last 15 minutes.</div>
        </div>
        <div class="monitor-card">
          <strong>${escapeHtml(spotlight?.agentName || "No spotlight yet")}</strong>
          <div class="panel-copy">${escapeHtml(spotlight?.reason || "The current loop leader will show here.")}</div>
        </div>
      </div>
    `;
  }

  function renderQuestBoard() {
    const quests = state.signals.questBoard || [];
    const director = state.signals.directorMode || null;
    $("quest-board-body").innerHTML = quests.length ? `
      <div class="monitor-list">
        ${director ? `
          <div class="monitor-card">
            <strong>${escapeHtml(director.label || "Director Mode")}</strong>
            <div class="panel-copy">${escapeHtml(director.recommendation || director.detail || "")}</div>
          </div>
        ` : ""}
        ${quests.slice(0, 3).map((quest) => `
          <div class="monitor-card">
            <strong>${escapeHtml(quest.title || "Live quest")}</strong>
            <div class="panel-copy">${escapeHtml(quest.detail || "")}</div>
          </div>
        `).join("")}
      </div>
    ` : "No live quests right now.";
  }

  function renderProgressionLadder() {
    const milestones = state.signals.milestoneBosses || [];
    $("world-ladder-body").innerHTML = milestones.length ? `
      <div class="monitor-list">
        ${milestones.map((entry) => `
          <div class="monitor-card">
            <strong>${escapeHtml(entry.label || "Milestone")}</strong>
            <div class="panel-copy">${escapeHtml(String(entry.state || "locked").toUpperCase())} | ${escapeHtml(entry.detail || "")}</div>
          </div>
        `).join("")}
      </div>
    ` : "No progression ladder milestones yet.";
  }

  function renderRoomMemberPicker() {
    return state.agents.map((agent) => `
      <label class="member-option">
        <input type="checkbox" data-room-draft-member="${escapeHtml(agent.id)}" ${state.groupDraftMembers.includes(agent.id) ? "checked" : ""}>
        <span>${escapeHtml(agent.name)}</span>
      </label>
    `).join("");
  }

  async function openOrCreateDirectRoom(agentId) {
    const agent = agentById(agentId);
    if (!agent) return;
    let chat = state.chats.find((entry) => entry.type === "direct" && (entry.members || []).includes(agentId));
    if (!chat) {
      const messenger = await requestJson("/api/messenger");
      messenger.chats.push({
        id: `direct-${agentId}`,
        type: "direct",
        title: agent.name,
        members: [agentId],
        messages: [{
          id: `msg-${Date.now()}`,
          role: "system",
          author: "Kirapolis",
          content: `${agent.name} direct thread created.`,
          createdAt: Date.now(),
        }],
        lastReadAt: 0,
        origin: "user",
      });
      messenger.activeChatId = `direct-${agentId}`;
      await requestJson("/api/messenger", "POST", messenger);
      await refreshOffice();
      chat = state.chats.find((entry) => entry.id === `direct-${agentId}`) || null;
    }
    if (chat) {
      state.selectedChatId = chat.id;
      renderRoomPreview();
      setDrawerView("rooms");
    }
  }

  async function createOfficeGroupChat() {
    const input = $("office-room-name");
    const name = String(input?.value || "").trim();
    const members = Array.from(new Set((state.groupDraftMembers || []).filter(Boolean)));
    if (!name) {
      setBanner("Name the room first.");
      return;
    }
    if (members.length < 2) {
      setBanner("Pick at least two members.");
      return;
    }
    const messenger = await requestJson("/api/messenger");
    const chatId = `group-${Date.now()}`;
    messenger.chats.push({
      id: chatId,
      type: "group",
      title: name,
      members,
      messages: [{
        id: `msg-${Date.now()}`,
        role: "system",
        author: "Kirapolis",
        content: `${name} created.`,
        createdAt: Date.now(),
      }],
      lastReadAt: 0,
      origin: "user",
    });
    messenger.activeChatId = chatId;
    await requestJson("/api/messenger", "POST", messenger);
    state.groupDraftMembers = [];
    if (input) input.value = "";
    await refreshOffice();
    state.selectedChatId = chatId;
    renderRoomPreview();
    setDrawerView("rooms");
    setBanner(`${name} created.`);
  }

  function renderRoomPreview() {
    const selectedChat = chatById(state.selectedChatId) || state.chats[0] || null;
    if (selectedChat && !state.selectedChatId) {
      state.selectedChatId = selectedChat.id;
    }
    const previousTranscript = $("room-preview-body")?.querySelector(".room-transcript");
    const captureScrollIntent = (container) => {
      if (!container) {
        return { scrollTop: 0, stickToBottom: true };
      }
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      const distanceFromBottom = maxScroll - container.scrollTop;
      return {
        scrollTop: container.scrollTop,
        stickToBottom: distanceFromBottom <= 48,
      };
    };
    const restoreScrollIntent = (container, intent, forceBottom = false) => {
      if (!container) return;
      window.requestAnimationFrame(() => {
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        if (forceBottom || intent?.stickToBottom) {
          container.scrollTop = maxScroll;
          return;
        }
        container.scrollTop = Math.min(Math.max(0, Number(intent?.scrollTop || 0)), maxScroll);
      });
    };
    const scrollIntent = captureScrollIntent(previousTranscript);
    const chatChanged = state.roomTranscriptScroll.chatId !== (selectedChat?.id || null);
    const recentMessages = (selectedChat?.messages || []).slice(-25);
    $("room-preview-body").innerHTML = `
      <div class="room-shell">
        <div class="panel">
          <div class="panel-label">Switch Rooms</div>
          <div class="room-list">
            ${state.chats.length ? state.chats.map((chat) => {
              const signal = computeChatSignal(chat);
              return `
                <button type="button" class="drawer-entry ${selectedChat?.id === chat.id ? "active" : ""}" data-room-id="${escapeHtml(chat.id)}">
                  <strong>${escapeHtml(chat.title)}</strong>
                  <span>${escapeHtml(chat.type === "group" ? "Group room" : "Direct thread")} | ${escapeHtml(signal.label)} | ${escapeHtml(String(signal.count || 0))} messages</span>
                </button>
              `;
            }).join("") : `<div class="drawer-empty">No rooms available yet.</div>`}
          </div>
        </div>

        ${selectedChat ? `
          <div class="room-window">
            <div class="room-window-head">
              <div>
                <div class="panel-label">Transcript</div>
                <strong>${escapeHtml(selectedChat.title)}</strong>
                <div class="room-window-meta">${escapeHtml(selectedChat.type === "group" ? "Group room" : "Direct thread")} | ${(selectedChat.members || []).map((id) => agentById(id)?.name || id).join(", ")}</div>
              </div>
              <div class="toolbar">
                <button type="button" class="primary" data-open-room-chat="${escapeHtml(selectedChat.id)}">Open Chat</button>
                <button type="button" data-room-preview-agent="${escapeHtml(state.selectedAgentId || "")}">Open Workspace</button>
              </div>
            </div>
            <div class="room-transcript">
              ${recentMessages.length ? recentMessages.map((message) => `
                <div class="room-message ${message.role === "user" ? "user" : ""}">
                  <div class="room-message-head">
                    <span>${escapeHtml(message.author || message.role || "Kirapolis")}</span>
                    <span>${escapeHtml(new Date(message.createdAt || Date.now()).toLocaleString())}</span>
                  </div>
                  <div class="room-message-body">${escapeHtml(message.content || "")}</div>
                </div>
              `).join("") : `<div class="drawer-empty">No transcript yet.</div>`}
            </div>
          </div>
        ` : ""}

        <div class="panel">
          <div class="panel-label">Direct Threads</div>
          <div class="agent-chip-grid">
            ${state.agents.map((agent) => {
              const direct = state.chats.find((chat) => chat.type === "direct" && (chat.members || []).includes(agent.id));
              const active = selectedChat?.id === direct?.id;
              return `<button type="button" class="agent-chip ${active ? "active" : ""}" data-direct-agent="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</button>`;
            }).join("")}
          </div>
        </div>

        <div class="panel room-create-grid">
          <div>
            <div class="panel-label">Create Group Room</div>
            <input id="office-room-name" placeholder="Manager Review Room">
          </div>
          <div>
            <div class="panel-label">Members</div>
            <div class="member-picker">${renderRoomMemberPicker()}</div>
          </div>
          <div class="toolbar">
            <button type="button" class="primary" id="office-create-room-btn">Create Room</button>
          </div>
        </div>
      </div>
    `;
    document.querySelectorAll("[data-room-id]").forEach((node) => {
      node.addEventListener("click", () => {
        state.selectedChatId = node.getAttribute("data-room-id");
        renderRoomPreview();
      });
    });
    document.querySelectorAll("[data-direct-agent]").forEach((node) => {
      node.addEventListener("click", () => {
        openOrCreateDirectRoom(node.getAttribute("data-direct-agent")).catch(() => null);
      });
    });
    document.querySelectorAll("[data-room-draft-member]").forEach((node) => {
      node.addEventListener("change", () => {
        const agentId = node.getAttribute("data-room-draft-member");
        if (!agentId) return;
        if (node.checked) {
          state.groupDraftMembers = Array.from(new Set([...state.groupDraftMembers, agentId]));
        } else {
          state.groupDraftMembers = state.groupDraftMembers.filter((entry) => entry !== agentId);
        }
      });
    });
    $("office-create-room-btn")?.addEventListener("click", () => {
      createOfficeGroupChat().catch(() => null);
    });
    $("room-preview-body").querySelector("[data-open-room-chat]")?.addEventListener("click", (event) => {
      openChatShortcut(event.currentTarget.getAttribute("data-open-room-chat"));
    });
    $("room-preview-body").querySelector("[data-room-preview-agent]")?.addEventListener("click", () => {
      $("office-preview-frame").src = getPreviewUrl();
      setDrawerView("preview");
    });
    const transcript = $("room-preview-body").querySelector(".room-transcript");
    if (transcript) {
      state.roomTranscriptScroll = {
        chatId: selectedChat?.id || null,
        scrollTop: scrollIntent.scrollTop,
        stickToBottom: scrollIntent.stickToBottom,
      };
      transcript.addEventListener("scroll", () => {
        state.roomTranscriptScroll = {
          chatId: selectedChat?.id || null,
          ...captureScrollIntent(transcript),
        };
      }, { passive: true });
      restoreScrollIntent(transcript, scrollIntent, chatChanged);
    }
  }

  function renderWorkspacePreview() {
    $("workspace-preview-body").innerHTML = `
      <div class="monitor-list">
        <div class="monitor-card">
          <strong>Files</strong>
          <div class="panel-copy">${state.files.slice(0, 4).map((item) => escapeHtml(item.name || item.path)).join(" | ") || "No indexed files yet."}</div>
        </div>
        <div class="monitor-card">
          <strong>Notes</strong>
          <div class="panel-copy">${state.notes.slice(0, 4).map((item) => escapeHtml(item.name || item.path)).join(" | ") || "No indexed notes yet."}</div>
        </div>
      </div>
    `;
  }

  function renderPromotionFeed() {
    const pulses = state.signals.pulseEvents || [];
    $("promotion-feed-body").innerHTML = pulses.length ? `
      <div class="monitor-list">
        ${pulses.slice(0, 5).map((entry) => `
          <div class="monitor-card">
            <strong>${escapeHtml(entry.agentName || entry.agentId || "Operator")}</strong>
            <div class="panel-copy">${escapeHtml(String(entry.type || "event").toUpperCase())} | ${escapeHtml(entry.title || "Live update")}</div>
          </div>
        `).join("")}
      </div>
    ` : "No recent system pulses.";
  }

  function selectAgent(agentId) {
    state.selectedAgentId = agentId;
    renderMap();
    renderAgentCard();
  }

  function openMenu(agentId, x, y) {
    state.menuAgentId = agentId;
    const agent = agentById(agentId);
    const menu = $("office-menu");
    const eligibleStars = Math.max(1, Number(agent?.progression?.promotionEligibleStars || 1));
    $("menu-promote-star-2").disabled = eligibleStars < 2 || (agent?.progression?.stars || 1) >= 2;
    $("menu-promote-star-3").disabled = eligibleStars < 3 || (agent?.progression?.stars || 1) >= 3;
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    menu.classList.remove("hidden");
  }

  function hideMenu() {
    $("office-menu").classList.add("hidden");
    state.menuAgentId = null;
  }

  function initDrawerResize() {
    const drawer = $("office-drawer");
    const handle = $("office-drawer-resize");
    if (!drawer || !handle) return;
    const savedWidth = Number(window.localStorage.getItem("kirapolis-office-drawer-width") || "");
    if (savedWidth) {
      drawer.style.width = `${savedWidth}px`;
    }
    handle.addEventListener("pointerdown", (event) => {
      if (window.innerWidth <= 1100) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = drawer.getBoundingClientRect().width;
      const move = (moveEvent) => {
        const nextWidth = clamp(startWidth + (startX - moveEvent.clientX), 360, Math.min(window.innerWidth - 36, 760));
        drawer.style.width = `${Math.round(nextWidth)}px`;
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        const finalWidth = Math.round(drawer.getBoundingClientRect().width);
        window.localStorage.setItem("kirapolis-office-drawer-width", String(finalWidth));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    });
  }

  async function promoteAgent(stars) {
    const agent = agentById(state.menuAgentId || state.selectedAgentId);
    if (!agent) return;
    const response = await fetch("/api/team/progression/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, stars }),
    });
    if (!response.ok) {
      hideMenu();
      return;
    }
    await refreshOffice();
    selectAgent(agent.id);
    hideMenu();
  }

  async function refreshOffice() {
    await ensureOfficeAssets();
    const [officeResponse, signalResponse] = await Promise.all([
      fetch("/api/team/office"),
      fetch("/api/experience/signals"),
    ]);
    await refreshWorkspaceIndexes();
    const data = await officeResponse.json();
    const signals = await signalResponse.json();
    state.agents = data.agents || [];
    state.tasks = data.tasks || [];
    state.activity = data.activity || [];
    state.chats = data.chats || [];
    state.files = data.files || [];
    state.notes = data.notes || [];
    state.summary = data.summary || {};
    state.formula = data.formula || "";
    state.signals = {
      syncPulseToken: signals.syncPulseToken || "",
      hotRooms: signals.hotRooms || [],
      blockedAgentIds: signals.blockedAgentIds || [],
      promotedAgentIds: signals.promotedAgentIds || [],
      summary: signals.summary || {},
      momentum: signals.momentum || null,
      spotlight: signals.spotlight || null,
      questBoard: signals.questBoard || [],
      promotionEvents: signals.promotionEvents || [],
      milestoneBosses: signals.milestoneBosses || [],
      behaviorStates: signals.behaviorStates || [],
      behaviorSummary: signals.behaviorSummary || {},
      socialLinks: signals.socialLinks || [],
      pulseEvents: signals.pulseEvents || [],
      ambientState: signals.ambientState || null,
      directorMode: signals.directorMode || null,
    };
    if (!agentById(state.selectedAgentId)) {
      state.selectedAgentId = null;
    }
    $("formula-text").textContent = `${state.summary.activeAgents || 0} active | ${state.summary.doingTasks || 0} building | ${state.summary.blockedTasks || 0} blocked | ${(state.signals.hotRooms || []).length} hot rooms`;
    $("agent-count").textContent = String(state.summary.agentCount || state.agents.length);
    $("completed-count").textContent = String(state.summary.completedTasks || 0);
    renderMap();
    renderAgentCard();
    renderLoopStatus();
    renderMomentum();
    renderQuestBoard();
    renderProgressionLadder();
    renderRoomPreview();
    renderPromotionFeed();
    renderWorkspacePreview();
    renderWorkspaceLists();
    if ($("office-preview-frame") && $("office-preview-frame").src !== getPreviewUrl()) {
      $("office-preview-frame").src = getPreviewUrl();
    }
    if ($("office-preview-link")) {
      $("office-preview-link").href = getPreviewUrl();
    }
  }

  function initEvents() {
    document.querySelectorAll("[data-drawer-view]").forEach((node) => {
      node.addEventListener("click", () => setDrawerView(node.getAttribute("data-drawer-view")));
    });
    $("refresh-office-data").addEventListener("click", () => {
      refreshOffice().catch(() => null);
      setBanner("Office refreshed.");
    });
    $("toggle-fullscreen")?.addEventListener("click", toggleFullscreen);
    $("open-preview-workspace").addEventListener("click", () => {
      const agent = agentById(state.selectedAgentId);
      $("office-preview-frame").src = getPreviewUrl();
      setDrawerView("preview");
      setBanner(agent ? `Workspace opened for ${agent.name}.` : "Workspace opened.");
    });
    $("office-preview-refresh")?.addEventListener("click", () => {
      $("office-preview-frame").src = getPreviewUrl();
      setBanner("Workspace site reloaded.");
    });
    $("office-files-back")?.addEventListener("click", () => goBackWorkspace("files"));
    $("office-notes-back")?.addEventListener("click", () => goBackWorkspace("notes"));
    $("office-drawer-close")?.addEventListener("click", () => {
      $("office-drawer").classList.add("hidden");
    });
    $("menu-open-card").addEventListener("click", () => {
      if (state.menuAgentId) {
        selectAgent(state.menuAgentId);
      }
      hideMenu();
      setDrawerView("agent");
    });
    $("menu-open-info").addEventListener("click", () => {
      if (state.menuAgentId) {
        selectAgent(state.menuAgentId);
      }
      hideMenu();
      setDrawerView("agent");
    });
    $("menu-promote-star-2").addEventListener("click", () => promoteAgent(2));
    $("menu-promote-star-3").addEventListener("click", () => promoteAgent(3));
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".context-menu")) {
        hideMenu();
      }
    });
    window.addEventListener("blur", hideMenu);
    window.addEventListener("resize", hideMenu);
  }

  initDrawerResize();
  initEvents();
  startMotionLoop();
  refreshOffice().catch(() => null);
  setInterval(() => {
    refreshMotionTargets();
  }, 3200);
  setInterval(() => {
    refreshOffice().catch(() => null);
  }, 10000);
})();
