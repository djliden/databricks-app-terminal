(() => {
  const tabsEl = document.getElementById("tabs");
  const terminalMainEl = document.getElementById("terminal-main");
  const createBtn = document.getElementById("create-session");

  const sessions = new Map();
  let activeSessionId = null;

  const LAUNCHER_SESSION_ID = "__launcher__";

  let sessionTypes = [
    {
      id: "terminal",
      name: "Terminal",
      description: "Plain shell session",
      badge: "terminal",
      icon: "⌂",
      default: true,
      builtIn: true,
    },
  ];

  function api(method, url, body) {
    return fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        const msg = payload?.error?.message || `Request failed (${response.status})`;
        throw new Error(msg);
      }
      return payload.data;
    });
  }

  function wsUrlFromPath(path) {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}${path}`;
  }

  function normalizeTypeId(typeId) {
    return typeof typeId === "string" && typeId.length > 0 ? typeId : "terminal";
  }

  function sortedSessionTypes(list) {
    return [...list].sort((a, b) => {
      if (a.default) {
        return -1;
      }
      if (b.default) {
        return 1;
      }
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
  }

  function setSessionTypes(types) {
    if (!Array.isArray(types) || types.length === 0) {
      return;
    }

    sessionTypes = sortedSessionTypes(
      types.map((type) => ({
        id: normalizeTypeId(type.id),
        name: type.name || type.id || "Terminal",
        description: type.description || "",
        badge: type.badge || type.id || "terminal",
        icon: typeof type.icon === "string" && type.icon.length > 0 ? type.icon : undefined,
        default: Boolean(type.default),
        builtIn: Boolean(type.builtIn),
      })),
    );
  }

  function findSessionType(typeId) {
    const normalized = normalizeTypeId(typeId);
    const found = sessionTypes.find((type) => type.id === normalized);

    if (found) {
      return found;
    }

    return {
      id: normalized,
      name: normalized,
      description: "",
      badge: normalized,
      icon: undefined,
      default: false,
      builtIn: false,
    };
  }

  function defaultTypeId() {
    const found = sessionTypes.find((type) => type.default);
    return found ? found.id : "terminal";
  }

  function typeLogo(type) {
    if (typeof type.icon === "string" && type.icon.length > 0) {
      return type.icon;
    }

    if (typeof type.badge === "string" && type.badge.length > 0) {
      return type.badge;
    }

    return type.id;
  }

  function visualLength(value) {
    return Array.from(value).length;
  }

  function truncateVisual(value, maxLength) {
    if (maxLength <= 0) {
      return "";
    }

    const chars = Array.from(value);
    if (chars.length <= maxLength) {
      return value;
    }

    if (maxLength === 1) {
      return "…";
    }

    return `${chars.slice(0, maxLength - 1).join("")}…`;
  }

  function padVisual(value, width) {
    const trimmed = truncateVisual(value, Math.max(0, width));
    const remaining = Math.max(0, width - visualLength(trimmed));
    return `${trimmed}${" ".repeat(remaining)}`;
  }

  function centerVisual(value, width) {
    const trimmed = truncateVisual(value, Math.max(0, width));
    const visible = visualLength(trimmed);
    if (visible >= width) {
      return trimmed;
    }

    const left = Math.floor((width - visible) / 2);
    const right = Math.max(0, width - visible - left);
    return `${" ".repeat(left)}${trimmed}${" ".repeat(right)}`;
  }

  function wrapVisual(value, width) {
    if (width <= 0) {
      return [""];
    }

    const normalized = String(value || "").trim();
    if (normalized.length === 0) {
      return [""];
    }

    const words = normalized.split(/\s+/).filter((part) => part.length > 0);
    if (words.length === 0) {
      return [""];
    }

    const lines = [];
    let current = "";

    for (const word of words) {
      const candidate = current.length > 0 ? `${current} ${word}` : word;
      if (visualLength(candidate) <= width) {
        current = candidate;
        continue;
      }

      if (current.length > 0) {
        lines.push(current);
      }

      if (visualLength(word) > width) {
        lines.push(truncateVisual(word, width));
        current = "";
        continue;
      }

      current = word;
    }

    if (current.length > 0) {
      lines.push(current);
    }

    return lines.length > 0 ? lines : [""];
  }

  function normalizeAuthMode(mode) {
    return mode === "user" || mode === "user-token" ? "user" : "m2m";
  }

  function authBadgeText(mode) {
    return mode === "user" ? "user" : "m2m";
  }

  function updateTabAuth(session) {
    const mode = normalizeAuthMode(session.authMode);
    session.authMode = mode;
    session.authEl.textContent = authBadgeText(mode);
    session.authEl.classList.toggle("user", mode === "user");
  }

  function updateTabType(session) {
    const type = findSessionType(session.typeId);

    if (type.id === "terminal") {
      if (session.typeEl) {
        session.typeEl.remove();
        session.typeEl = null;
      }
      return;
    }

    if (!session.typeEl) {
      const typeEl = document.createElement("span");
      typeEl.className = "tab-type";
      session.typeEl = typeEl;
      session.tabEl.insertBefore(typeEl, session.authEl);
    }

    session.typeEl.textContent = typeLogo(type);
  }

  function shortSessionLabel(sessionId) {
    return sessionId.slice(0, 8);
  }

  function displayTitle(session) {
    return session.dynamicTitle && session.dynamicTitle.trim().length > 0
      ? session.dynamicTitle.trim()
      : shortSessionLabel(session.sessionId);
  }

  function updateTabTitle(session) {
    session.labelEl.textContent = displayTitle(session);
  }

  function updateTabStatus(sessionId, status) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.status = status;
    session.statusEl.classList.remove("connected", "disconnected", "closed");
    session.statusEl.classList.add(status);
  }

  function sendResize(session) {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    session.socket.send(
      JSON.stringify({
        type: "resize",
        cols: session.terminal.cols,
        rows: session.terminal.rows,
      }),
    );
  }

  function fitAndResizeSession(session) {
    requestAnimationFrame(() => {
      session.fitAddon.fit();
      sendResize(session);

      if (session.inlinePicker && session.inlinePicker.initialized) {
        renderInlineSessionTypePicker(session);
      }
    });
  }

  function focusSessionTerminal(session) {
    requestAnimationFrame(() => {
      session.terminal.focus();
    });
  }

  function isLauncherSession(session) {
    return Boolean(session && session.sessionId === LAUNCHER_SESSION_ID);
  }

  function activeInlinePickerSession() {
    for (const session of sessions.values()) {
      if (session.inlinePicker) {
        return session;
      }
    }
    return null;
  }

  function closeInlineSessionTypePicker(session, flushBufferedOutput = true) {
    if (!session || !session.inlinePicker) {
      return;
    }

    const bufferedOutput = session.inlinePicker.bufferedOutput.join("");
    session.inlinePicker = null;

    session.terminal.write("\u001b[?25h\u001b[?1049l");

    if (flushBufferedOutput && bufferedOutput.length > 0) {
      session.terminal.write(bufferedOutput);
    }

    focusSessionTerminal(session);
  }

  function closeAnyInlineSessionTypePicker(flushBufferedOutput = true) {
    for (const session of sessions.values()) {
      if (session.inlinePicker) {
        closeInlineSessionTypePicker(session, flushBufferedOutput);
      }
    }
  }

  function renderInlineSessionTypePicker(session) {
    const picker = session.inlinePicker;
    if (!picker) {
      return;
    }

    const mode = picker.mode || "home";

    const terminalCols = Math.max(40, session.terminal.cols || 80);
    const terminalRows = Math.max(16, session.terminal.rows || 24);
    const maxBoxWidth = Math.max(30, terminalCols - 2);
    const boxWidth = Math.min(84, maxBoxWidth);
    const innerWidth = Math.max(24, boxWidth - 4);

    const colorize = (text, tone) => {
      if (tone === "title") {
        return `\u001b[1;96m${text}\u001b[0m`;
      }
      if (tone === "accent") {
        return `\u001b[94m${text}\u001b[0m`;
      }
      if (tone === "muted") {
        return `\u001b[90m${text}\u001b[0m`;
      }
      return text;
    };

    const frameLine = (text, tone = "plain", options = {}) => {
      const reserveRight = Math.max(0, Number(options.reserveRight || 0));
      const coreWidth = Math.max(0, innerWidth - reserveRight);
      const padded = `${padVisual(text, coreWidth)}${" ".repeat(reserveRight)}`;
      return `│ ${colorize(padded, tone)} │`;
    };

    const maxBoxHeight = Math.max(12, terminalRows - 2);
    const maxInnerHeight = Math.max(10, maxBoxHeight - 2);

    const lines = [];
    lines.push(`┌${"─".repeat(boxWidth - 2)}┐`);

    if (mode === "home") {
      const introTitle = picker.replaceOnSelect
        ? "Start your first terminal session"
        : "Launch another terminal session";

      const introBody = picker.replaceOnSelect
        ? "Welcome. This app provides PTY-backed tabs for Databricks Apps with per-session auth switching."
        : "Pick a profile to open a new tab. Profiles can bootstrap their own CLI via launch.sh.";

      const introTips = "Tip: switch auth per tab via badge, or run dbx-auth in-shell.";

      const wrappedIntro = [...wrapVisual(introBody, innerWidth), ...wrapVisual(introTips, innerWidth)].slice(0, 3);

      const headerLines = [
        { text: centerVisual("Databricks App Terminal", innerWidth), tone: "title" },
        { text: centerVisual(introTitle, innerWidth), tone: "accent" },
        { text: centerVisual("Multi-session terminal runtime", innerWidth), tone: "muted" },
        { text: "", tone: "plain" },
        ...wrappedIntro.map((line) => ({ text: line, tone: "muted" })),
        { text: "", tone: "plain" },
        { text: "Profiles", tone: "accent" },
      ];

      const footerLineCount = 4;
      const typeLineBudget = Math.max(2, maxInnerHeight - headerLines.length - footerLineCount);
      const visibleSlots = Math.max(1, Math.floor(typeLineBudget / 2));

      let startIndex = 0;
      if (sessionTypes.length > visibleSlots) {
        startIndex = picker.selectedIndex - Math.floor(visibleSlots / 2);
        startIndex = Math.max(0, startIndex);
        startIndex = Math.min(startIndex, sessionTypes.length - visibleSlots);
      }

      const endIndex = Math.min(sessionTypes.length, startIndex + visibleSlots);

      for (const line of headerLines) {
        lines.push(frameLine(line.text, line.tone));
      }

      for (let index = startIndex; index < endIndex; index += 1) {
        const type = sessionTypes[index];
        const isSelected = index === picker.selectedIndex;
        const marker = isSelected ? "❯" : " ";
        const shortcut = index < 9 ? String(index + 1) : " ";
        const defaultSuffix = type.default ? " · default" : "";
        const summary = `${marker} [${shortcut}] ${typeLogo(type)} ${type.name}${defaultSuffix}`;
        const detail = `    ${type.id}${type.description ? ` · ${type.description}` : ""}`;

        lines.push(frameLine(summary, isSelected ? "accent" : "plain", { reserveRight: 1 }));
        lines.push(frameLine(detail, "muted", { reserveRight: 1 }));
      }

      const showing = sessionTypes.length > visibleSlots
        ? `Showing ${startIndex + 1}-${endIndex} of ${sessionTypes.length}`
        : `Showing ${sessionTypes.length} profile${sessionTypes.length === 1 ? "" : "s"}`;

      const action = picker.replaceOnSelect
        ? "Selection replaces this launcher tab"
        : "Selection opens a new tab";

      const escapeHint = picker.blocking ? "Esc back" : "Esc close";

      lines.push(frameLine(""));
      lines.push(frameLine(showing, "muted"));
      lines.push(frameLine(action, "muted"));
      lines.push(frameLine(`↑/↓ or j/k navigate · Enter launch · ? help · a about · ${escapeHint}`, "muted"));
    } else if (mode === "help") {
      const helpEscText = picker.blocking
        ? "  Esc              Return to profile list"
        : "  Esc              Close launcher";

      const helpRows = [
        { text: centerVisual("Launcher Help", innerWidth), tone: "title" },
        { text: centerVisual("Keyboard-first terminal UX", innerWidth), tone: "muted" },
        { text: "", tone: "plain" },
        { text: "Navigation", tone: "accent" },
        { text: "  ↑/↓ or j/k      Move profile selection", tone: "plain" },
        { text: "  1..9             Quick launch by row index", tone: "plain" },
        { text: "  Enter            Launch selected profile", tone: "plain" },
        { text: "", tone: "plain" },
        { text: "Panels", tone: "accent" },
        { text: "  ?                Toggle this help panel", tone: "plain" },
        { text: "  a                Toggle About panel", tone: "plain" },
        { text: helpEscText, tone: "plain" },
        { text: "", tone: "plain" },
        { text: "Enter/Backspace returns to profile list.", tone: "muted" },
      ];

      for (const row of helpRows.slice(0, maxInnerHeight)) {
        lines.push(frameLine(row.text, row.tone));
      }
    } else {
      const aboutLines = [
        { text: centerVisual("About Databricks App Terminal", innerWidth), tone: "title" },
        { text: centerVisual("Terminal runtime for Databricks Apps", innerWidth), tone: "muted" },
        { text: "", tone: "plain" },
      ];

      const copy = [
        "This launcher lets you choose a terminal profile before starting a backend shell session.",
        `Configured profiles in this app: ${sessionTypes.length}.`,
        "Each profile can run custom launch.sh setup while sharing the same core auth/session substrate.",
        "Per-tab auth can be switched via badge or dbx-auth command.",
      ];

      for (const paragraph of copy) {
        for (const line of wrapVisual(paragraph, innerWidth)) {
          aboutLines.push({ text: line, tone: "plain" });
        }
        aboutLines.push({ text: "", tone: "plain" });
      }

      const aboutEscText = picker.blocking ? "Esc returns to profile list." : "Esc closes launcher.";
      aboutLines.push({ text: `Press Enter/Backspace to return. ${aboutEscText}`, tone: "muted" });

      for (const row of aboutLines.slice(0, maxInnerHeight)) {
        lines.push(frameLine(row.text, row.tone));
      }
    }

    lines.push(`└${"─".repeat(boxWidth - 2)}┘`);

    const frameHeight = lines.length;
    const topPad = Math.max(0, Math.floor((terminalRows - frameHeight) / 2));
    const leftPad = Math.max(0, Math.floor((terminalCols - boxWidth) / 2));

    const outputLines = [];
    for (let index = 0; index < topPad; index += 1) {
      outputLines.push("");
    }

    const leftPadText = " ".repeat(leftPad);
    for (const line of lines) {
      outputLines.push(`${leftPadText}${line}`);
    }

    session.terminal.write(`\u001b[2J\u001b[H${outputLines.join("\r\n")}`);
  }

  function setInlineSessionTypePickerMode(session, mode) {
    if (!session || !session.inlinePicker) {
      return;
    }

    session.inlinePicker.mode = mode;
    renderInlineSessionTypePicker(session);
  }

  let terminalIconFontReadyPromise = null;

  function waitForTerminalIconFontReady(timeoutMs = 1500) {
    if (terminalIconFontReadyPromise) {
      return terminalIconFontReadyPromise;
    }

    if (!document.fonts || typeof document.fonts.load !== "function") {
      terminalIconFontReadyPromise = Promise.resolve();
      return terminalIconFontReadyPromise;
    }

    const settle = Promise.all([
      document.fonts.load('16px "DBX Term Icons"', "\uE001"),
      document.fonts.load('16px "DBX Term Icons"', "\uE002"),
      document.fonts.load('16px "DBX Term Icons"', "\uE003"),
      document.fonts.ready,
    ]).then(() => undefined).catch(() => undefined);

    const timeout = new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    });

    terminalIconFontReadyPromise = Promise.race([settle, timeout]).then(() => undefined);
    return terminalIconFontReadyPromise;
  }

  function scheduleInlinePickerFirstRender(session) {
    waitForTerminalIconFontReady().finally(() => {
      let remainingPasses = 2;

      const pass = () => {
        if (!session.inlinePicker) {
          return;
        }

        session.fitAddon.fit();
        sendResize(session);

        if (remainingPasses > 0) {
          remainingPasses -= 1;
          requestAnimationFrame(pass);
          return;
        }

        session.inlinePicker.initialized = true;
        renderInlineSessionTypePicker(session);
        focusSessionTerminal(session);
      };

      requestAnimationFrame(pass);
    });
  }

  function moveInlineSessionTypePicker(delta) {
    const session = activeInlinePickerSession();
    if (!session || !session.inlinePicker || session.inlinePicker.mode !== "home" || sessionTypes.length === 0) {
      return;
    }

    const count = sessionTypes.length;
    session.inlinePicker.selectedIndex = ((session.inlinePicker.selectedIndex + delta) % count + count) % count;
    renderInlineSessionTypePicker(session);
  }

  function handleInlineSessionTypePickerKey(session, domEvent) {
    if (!session.inlinePicker) {
      return false;
    }

    const key = domEvent.key;
    const lower = key.toLowerCase();
    const hasModifiers = domEvent.metaKey || domEvent.ctrlKey || domEvent.altKey;
    const mode = session.inlinePicker.mode || "home";
    const blocking = Boolean(session.inlinePicker.blocking);

    if (!session.inlinePicker.initialized) {
      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    if (key === "Escape") {
      if (mode !== "home") {
        setInlineSessionTypePickerMode(session, "home");
      } else if (!blocking) {
        closeInlineSessionTypePicker(session);
      }

      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    if (!hasModifiers && key === "?") {
      setInlineSessionTypePickerMode(session, mode === "help" ? "home" : "help");
      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    if (!hasModifiers && lower === "a") {
      setInlineSessionTypePickerMode(session, mode === "about" ? "home" : "about");
      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    if (mode !== "home") {
      if (key === "Enter" || key === "Backspace" || key === " ") {
        setInlineSessionTypePickerMode(session, "home");
      }
      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    if (key === "ArrowDown" || (!hasModifiers && lower === "j")) {
      moveInlineSessionTypePicker(1);
      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    if (key === "ArrowUp" || (!hasModifiers && lower === "k")) {
      moveInlineSessionTypePicker(-1);
      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    if (key === "Enter") {
      chooseInlineSessionType();
      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    if (/^[1-9]$/.test(key)) {
      chooseInlineSessionType(Number(key) - 1);
      domEvent.preventDefault();
      domEvent.stopPropagation();
      return true;
    }

    domEvent.preventDefault();
    domEvent.stopPropagation();
    return true;
  }

  function chooseInlineSessionType(index) {
    const session = activeInlinePickerSession();
    if (!session || !session.inlinePicker || session.inlinePicker.mode !== "home" || sessionTypes.length === 0) {
      return;
    }

    if (typeof index === "number" && Number.isInteger(index)) {
      if (index < 0 || index >= sessionTypes.length) {
        return;
      }
      session.inlinePicker.selectedIndex = index;
    }

    const selectedType = sessionTypes[session.inlinePicker.selectedIndex] || {
      id: defaultTypeId(),
    };

    const replaceOnSelect = Boolean(session.inlinePicker.replaceOnSelect);
    const currentTypeId = session.typeId;
    const launcher = isLauncherSession(session);

    closeInlineSessionTypePicker(session, !replaceOnSelect);

    if (replaceOnSelect) {
      if (!launcher && selectedType.id === currentTypeId) {
        return;
      }

      closeSessionUi(session.sessionId, {
        suppressAutoCreate: true,
      });

      if (!launcher) {
        api("DELETE", `/api/sessions/${encodeURIComponent(session.sessionId)}`)
          .catch((error) => {
            if ((error.message || "").toLowerCase().includes("not found")) {
              return;
            }
            console.warn(`Failed to close session ${session.sessionId}:`, error.message);
          });
      }

      createSession(selectedType.id);
      return;
    }

    createSession(selectedType.id);
  }

  function openInlineSessionTypePicker(sessionId = activeSessionId, options = {}) {
    const session = sessionId ? sessions.get(sessionId) : null;

    if (!session) {
      mountLauncherSession(true);
      openInlineSessionTypePicker(LAUNCHER_SESSION_ID, {
        replaceOnSelect: true,
      });
      return;
    }

    if (session.inlinePicker) {
      if (!session.inlinePicker.blocking) {
        closeInlineSessionTypePicker(session);
      }
      return;
    }

    closeAnyInlineSessionTypePicker();

    let selectedIndex = sessionTypes.findIndex((type) => type.default);
    if (selectedIndex < 0) {
      selectedIndex = 0;
    }

    const replaceOnSelect = options.replaceOnSelect === undefined
      ? isLauncherSession(session)
      : Boolean(options.replaceOnSelect);

    const blocking = options.blocking === undefined
      ? (isLauncherSession(session) && replaceOnSelect)
      : Boolean(options.blocking);

    session.inlinePicker = {
      mode: "home",
      selectedIndex,
      bufferedOutput: [],
      replaceOnSelect,
      blocking,
      initialized: false,
    };

    session.terminal.write("\u001b[?1049h\u001b[?25l");
    scheduleInlinePickerFirstRender(session);
  }

  function activateSession(sessionId) {
    const pickerSession = activeInlinePickerSession();
    if (pickerSession && pickerSession.sessionId !== sessionId) {
      closeInlineSessionTypePicker(pickerSession);
    }

    activeSessionId = sessionId;

    for (const [id, session] of sessions.entries()) {
      const isActive = id === sessionId;
      session.tabEl.classList.toggle("active", isActive);
      session.paneEl.classList.toggle("active", isActive);
    }

    const active = sessions.get(sessionId);
    if (active) {
      fitAndResizeSession(active);
      setTimeout(() => {
        if (activeSessionId === sessionId) {
          fitAndResizeSession(active);
        }
      }, 80);
      focusSessionTerminal(active);
    }
  }

  function closeSessionUi(sessionId, options = {}) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.inlinePicker) {
      closeInlineSessionTypePicker(session, false);
    }

    if (session.socket) {
      session.socket.close();
      session.socket = null;
    }

    session.terminal.dispose();
    session.tabEl.remove();
    session.paneEl.remove();
    sessions.delete(sessionId);

    if (activeSessionId === sessionId) {
      const first = sessions.keys().next();
      activeSessionId = null;
      if (!first.done) {
        activateSession(first.value);
      }
    }

    if (sessions.size === 0 && !options.suppressAutoCreate) {
      mountLauncherSession(true);
      openInlineSessionTypePicker(LAUNCHER_SESSION_ID, {
        replaceOnSelect: true,
      });
    }
  }

  function killSession(sessionId, options = {}) {
    api("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`)
      .then(() => {
        closeSessionUi(sessionId, options);
      })
      .catch((error) => {
        if ((error.message || "").toLowerCase().includes("not found")) {
          closeSessionUi(sessionId, options);
          return;
        }
        console.warn(`Failed to close session ${sessionId}:`, error.message);
      });
  }

  function toggleSessionAuthMode(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    const nextMode = session.authMode === "user" ? "m2m" : "user";

    api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/auth-mode`, {
      mode: nextMode,
    })
      .then((data) => {
        session.authMode = normalizeAuthMode(data.authMode);
        updateTabAuth(session);
      })
      .catch((error) => {
        console.warn(`Failed to switch auth mode (${sessionId}):`, error.message);
        session.terminal.writeln(`\r\n[error] ${error.message}`);
      });
  }

  function connectSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/attach`, {})
      .then((data) => {
        const socket = new WebSocket(wsUrlFromPath(data.websocketPath));
        session.socket = socket;

        socket.addEventListener("open", () => {
          updateTabStatus(sessionId, "connected");
          fitAndResizeSession(session);
        });

        socket.addEventListener("message", (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }

          if (msg.type === "ready") {
            updateTabStatus(sessionId, "connected");
            fitAndResizeSession(session);
            return;
          }

          if (msg.type === "auth_mode") {
            session.authMode = normalizeAuthMode(msg.mode);
            updateTabAuth(session);
            return;
          }

          if (msg.type === "output") {
            if (session.inlinePicker) {
              session.inlinePicker.bufferedOutput.push(msg.data);
              return;
            }

            session.terminal.write(msg.data);
            return;
          }

          if (msg.type === "exit") {
            if (session.inlinePicker) {
              closeInlineSessionTypePicker(session);
            }

            updateTabStatus(sessionId, "closed");
            session.terminal.writeln(`\r\n[process exited: code=${msg.exitCode}]`);
            return;
          }

          if (msg.type === "error") {
            if (session.inlinePicker) {
              closeInlineSessionTypePicker(session);
            }
            session.terminal.writeln(`\r\n[error] ${msg.message}`);
          }
        });

        socket.addEventListener("close", () => {
          if (session.inlinePicker) {
            closeInlineSessionTypePicker(session);
          }

          if (sessions.has(sessionId)) {
            updateTabStatus(sessionId, "disconnected");
          }
        });

        socket.addEventListener("error", () => {
          if (session.inlinePicker) {
            closeInlineSessionTypePicker(session);
          }

          if (sessions.has(sessionId)) {
            updateTabStatus(sessionId, "disconnected");
          }
        });
      })
      .catch((error) => {
        console.warn(`Attach failed (${sessionId}):`, error.message);
      });
  }

  function mountSession(sessionId, authMode = "m2m", typeId = "terminal", activate = true, options = {}) {
    if (sessions.has(sessionId)) {
      if (activate) {
        activateSession(sessionId);
      }
      return;
    }

    const isLauncher = Boolean(options.launcher);

    const tabEl = document.createElement("div");
    tabEl.className = isLauncher ? "tab launcher" : "tab";

    const closeEl = document.createElement("button");
    closeEl.className = "tab-close";
    closeEl.type = "button";
    closeEl.setAttribute("aria-label", `Close ${sessionId}`);
    closeEl.textContent = "×";

    const authEl = document.createElement("button");
    authEl.className = "tab-auth";
    authEl.type = "button";
    authEl.setAttribute("aria-label", `Toggle auth mode for ${sessionId}`);

    const labelEl = document.createElement("span");
    labelEl.className = "tab-label";

    const statusEl = document.createElement("span");
    statusEl.className = "tab-status disconnected";

    tabEl.appendChild(closeEl);
    tabEl.appendChild(authEl);
    tabEl.appendChild(labelEl);
    tabEl.appendChild(statusEl);
    tabsEl.appendChild(tabEl);

    if (isLauncher) {
      closeEl.tabIndex = -1;
      closeEl.setAttribute("aria-hidden", "true");
      authEl.tabIndex = -1;
      authEl.setAttribute("aria-hidden", "true");
      statusEl.setAttribute("aria-hidden", "true");
    }

    const paneEl = document.createElement("section");
    paneEl.className = "terminal-pane";

    const hostEl = document.createElement("div");
    hostEl.className = "terminal-host";
    paneEl.appendChild(hostEl);
    terminalMainEl.appendChild(paneEl);

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 15,
      fontFamily: '"DBX Term Icons", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#0b0d10",
      },
      scrollback: 2000,
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostEl);

    const state = {
      sessionId,
      tabEl,
      closeEl,
      typeEl: null,
      authEl,
      labelEl,
      paneEl,
      statusEl,
      terminal,
      fitAddon,
      socket: null,
      status: isLauncher ? "connected" : "disconnected",
      authMode: normalizeAuthMode(authMode),
      typeId: normalizeTypeId(typeId),
      dynamicTitle: typeof options.dynamicTitle === "string" ? options.dynamicTitle : "",
      inlinePicker: null,
      isLauncher,
    };

    sessions.set(sessionId, state);
    updateTabTitle(state);
    updateTabType(state);
    updateTabAuth(state);

    if (isLauncher) {
      updateTabStatus(sessionId, "connected");
    }

    terminal.onData((data) => {
      if (state.inlinePicker) {
        return;
      }

      if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        return;
      }

      state.socket.send(
        JSON.stringify({
          type: "input",
          data,
        }),
      );
    });

    if (typeof terminal.onKey === "function") {
      terminal.onKey(({ domEvent }) => {
        handleInlineSessionTypePickerKey(state, domEvent);
      });
    }

    if (typeof terminal.onTitleChange === "function") {
      terminal.onTitleChange((title) => {
        state.dynamicTitle = title || "";
        updateTabTitle(state);
      });
    }

    tabEl.addEventListener("click", () => {
      activateSession(sessionId);
    });

    if (!isLauncher) {
      closeEl.addEventListener("click", (event) => {
        event.stopPropagation();
        killSession(sessionId);
      });

      authEl.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleSessionAuthMode(sessionId);
      });
    }

    if (options.connect !== false) {
      connectSession(sessionId);
    }

    if (activate || !activeSessionId) {
      activateSession(sessionId);
    }
  }

  function mountLauncherSession(activate = true) {
    if (sessions.has(LAUNCHER_SESSION_ID)) {
      if (activate) {
        activateSession(LAUNCHER_SESSION_ID);
      }
      return;
    }

    mountSession(LAUNCHER_SESSION_ID, "m2m", "terminal", activate, {
      launcher: true,
      connect: false,
      dynamicTitle: "New session",
    });
  }

  function loadSessionTypes() {
    return api("GET", "/api/session-types")
      .then((data) => {
        setSessionTypes(data.types || []);
      })
      .catch((error) => {
        console.warn("Loading session types failed:", error.message);
      });
  }

  function createSession(typeId = "terminal", options = {}) {
    const body = {};
    if (normalizeTypeId(typeId) !== "terminal") {
      body.typeId = normalizeTypeId(typeId);
    }

    api("POST", "/api/sessions", body)
      .then((data) => {
        const sessionId = data.session.sessionId;

        mountSession(
          sessionId,
          data.authMode || data.session.authMode || "m2m",
          data.typeId || data.session.typeId || typeId,
          true,
        );

        if (options.openPicker) {
          openInlineSessionTypePicker(sessionId, {
            replaceOnSelect: Boolean(options.replaceOnSelect),
          });
        }
      })
      .catch((error) => {
        console.warn("Create session failed:", error.message);
      });
  }

  function loadExistingSessions() {
    api("GET", "/api/sessions")
      .then((data) => {
        for (const session of data.sessions) {
          mountSession(session.sessionId, session.authMode || "m2m", session.typeId || "terminal", false);
        }

        if (sessions.size > 0) {
          const first = sessions.keys().next();
          if (!first.done) {
            activateSession(first.value);
          }
          return;
        }

        mountLauncherSession(true);
        openInlineSessionTypePicker(LAUNCHER_SESSION_ID, {
          replaceOnSelect: true,
        });
      })
      .catch((error) => {
        console.warn("Loading sessions failed:", error.message);
      });
  }

  function handleGlobalKeyDown(event) {
    const key = event.key.toLowerCase();
    const isNewTabShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && key === "t";

    if (!isNewTabShortcut) {
      return;
    }

    event.preventDefault();
    openInlineSessionTypePicker();
  }

  window.addEventListener("resize", () => {
    if (!activeSessionId) {
      return;
    }

    const session = sessions.get(activeSessionId);
    if (!session) {
      return;
    }

    fitAndResizeSession(session);
  });

  window.addEventListener("keydown", handleGlobalKeyDown);
  createBtn.addEventListener("click", openInlineSessionTypePicker);

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      if (!activeSessionId) {
        return;
      }

      const session = sessions.get(activeSessionId);
      if (!session) {
        return;
      }

      fitAndResizeSession(session);
    });

    resizeObserver.observe(terminalMainEl);
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (!activeSessionId) {
        return;
      }

      const session = sessions.get(activeSessionId);
      if (!session) {
        return;
      }

      fitAndResizeSession(session);
    });
  }

  loadSessionTypes().finally(() => {
    loadExistingSessions();
  });
})();
